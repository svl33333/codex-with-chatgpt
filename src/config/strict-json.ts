import fs from "node:fs";

export type StrictJsonFailureKind = "MISSING" | "MALFORMED" | "CORRUPT";

export class StrictJsonError extends Error {
  readonly kind: Exclude<StrictJsonFailureKind, "MISSING">;
  readonly offset: number;

  constructor(kind: Exclude<StrictJsonFailureKind, "MISSING">, message: string, offset: number) {
    super(message);
    this.name = "StrictJsonError";
    this.kind = kind;
    this.offset = offset;
  }
}

export interface StrictJsonReadResult<T> {
  status: "OK" | StrictJsonFailureKind;
  value?: T;
  error?: StrictJsonError;
}

/**
 * A small JSON parser used only at A1 trust boundaries.  It deliberately
 * decodes member names before comparing them so escaped and literal spellings
 * of the same name are treated as duplicates.  It returns ordinary JSON data
 * after the raw boundary has been checked; no prototype-bearing object is
 * created while parsing.
 */
class Parser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (!this.atEnd()) this.fail("unexpected trailing content");
    return value;
  }

  private atEnd(): boolean {
    return this.index >= this.text.length;
  }

  private current(): string {
    return this.text[this.index] ?? "";
  }

  private skipWhitespace(): void {
    while (!this.atEnd() && /[\u0009\u000a\u000d\u0020]/.test(this.current())) this.index += 1;
  }

  private fail(message: string): never {
    throw new StrictJsonError("MALFORMED", message, this.index);
  }

  private expect(character: string): void {
    if (this.current() !== character) this.fail(`expected ${character}`);
    this.index += 1;
  }

  private parseValue(): unknown {
    const character = this.current();
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === '"') return this.parseString();
    if (character === "t" && this.text.slice(this.index, this.index + 4) === "true") {
      this.index += 4;
      return true;
    }
    if (character === "f" && this.text.slice(this.index, this.index + 5) === "false") {
      this.index += 5;
      return false;
    }
    if (character === "n" && this.text.slice(this.index, this.index + 4) === "null") {
      this.index += 4;
      return null;
    }
    if (character === "-" || /[0-9]/.test(character)) return this.parseNumber();
    this.fail("invalid JSON value");
  }

  private parseObject(): Record<string, unknown> {
    this.expect("{");
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const names = new Set<string>();
    this.skipWhitespace();
    if (this.current() === "}") {
      this.index += 1;
      return result;
    }
    while (true) {
      this.skipWhitespace();
      if (this.current() !== '"') this.fail("object member name must be a string");
      const name = this.parseString();
      if (typeof name !== "string") this.fail("object member name must be a string");
      if (names.has(name)) throw new StrictJsonError("MALFORMED", `duplicate object member: ${name}`, this.index);
      names.add(name);
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      result[name] = this.parseValue();
      this.skipWhitespace();
      if (this.current() === "}") {
        this.index += 1;
        return result;
      }
      this.expect(",");
    }
  }

  private parseArray(): unknown[] {
    this.expect("[");
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.current() === "]") {
      this.index += 1;
      return result;
    }
    while (true) {
      this.skipWhitespace();
      result.push(this.parseValue());
      this.skipWhitespace();
      if (this.current() === "]") {
        this.index += 1;
        return result;
      }
      this.expect(",");
    }
  }

  private parseString(): string {
    this.expect('"');
    let result = "";
    while (!this.atEnd()) {
      const character = this.current();
      this.index += 1;
      if (character === '"') return result;
      if (character.charCodeAt(0) < 0x20) this.fail("control character in string");
      if (character !== "\\") {
        result += character;
        continue;
      }
      if (this.atEnd()) this.fail("unterminated escape");
      const escaped = this.current();
      this.index += 1;
      switch (escaped) {
        case '"': result += '"'; break;
        case "\\": result += "\\"; break;
        case "/": result += "/"; break;
        case "b": result += "\b"; break;
        case "f": result += "\f"; break;
        case "n": result += "\n"; break;
        case "r": result += "\r"; break;
        case "t": result += "\t"; break;
        case "u": {
          const hex = this.text.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("invalid unicode escape");
          this.index += 4;
          const code = Number.parseInt(hex, 16);
          // Preserve JSON's UTF-16 semantics, including surrogate pairs. A
          // lone surrogate is still a valid JSON string and is left intact.
          result += String.fromCharCode(code);
          break;
        }
        default: this.fail("invalid string escape");
      }
    }
    this.fail("unterminated string");
  }

  private parseNumber(): number {
    const start = this.index;
    if (this.current() === "-") this.index += 1;
    if (this.current() === "0") {
      this.index += 1;
    } else {
      if (!/[1-9]/.test(this.current())) this.fail("invalid number");
      while (/[0-9]/.test(this.current())) this.index += 1;
    }
    if (this.current() === ".") {
      this.index += 1;
      if (!/[0-9]/.test(this.current())) this.fail("invalid number fraction");
      while (/[0-9]/.test(this.current())) this.index += 1;
    }
    if (this.current() === "e" || this.current() === "E") {
      this.index += 1;
      if (this.current() === "+" || this.current() === "-") this.index += 1;
      if (!/[0-9]/.test(this.current())) this.fail("invalid number exponent");
      while (/[0-9]/.test(this.current())) this.index += 1;
    }
    const raw = this.text.slice(start, this.index);
    const value = Number(raw);
    if (!Number.isFinite(value)) this.fail("number is not finite");
    return value;
  }
}

export function parseStrictJson<T = unknown>(raw: string): T {
  if (typeof raw !== "string" || raw.length === 0) throw new StrictJsonError("MALFORMED", "JSON input is empty", 0);
  return new Parser(raw).parse() as T;
}

export function readStrictJsonFile<T = unknown>(file: string): StrictJsonReadResult<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "MISSING" };
    const wrapped = new StrictJsonError("CORRUPT", "unable to read JSON record", 0);
    return { status: "CORRUPT", error: wrapped };
  }
  try {
    return { status: "OK", value: parseStrictJson<T>(raw) };
  } catch (error) {
    const strict = error instanceof StrictJsonError ? error : new StrictJsonError("CORRUPT", "unable to parse JSON record", 0);
    return { status: strict.kind === "MALFORMED" ? "MALFORMED" : "CORRUPT", error: strict };
  }
}

export function readStrictJsonOrThrow<T = unknown>(file: string): T {
  const result = readStrictJsonFile<T>(file);
  if (result.status === "OK") return result.value as T;
  throw result.error ?? new StrictJsonError(result.status === "MISSING" ? "CORRUPT" : result.status, `strict JSON ${result.status.toLowerCase()}: ${file}`, 0);
}

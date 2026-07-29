export type PromptVariables = Record<string, string | number | boolean>;

export interface FewShotExample {
  input: string;
  output: string;
}

/**
 * 任何带 render(variables?) => string 的对象都可以作为 prompt 传给 Agent。
 * PromptTemplate / DynamicPrompt / VersionedPrompt 都实现此接口。
 */
export interface PromptLike {
  render(variables?: PromptVariables): string;
}

export interface PromptTemplateOptions {
  defaultVariables?: PromptVariables;
  examples?: FewShotExample[];
}

const VAR_PATTERN = /{{\s*(\w+)\s*}}/g;

export class PromptTemplate implements PromptLike {
  constructor(
    private template: string,
    private options?: PromptTemplateOptions,
  ) {}

  /** 模板里出现的所有 {{var}} 名（去重）。供调用方主动校验是否传齐。 */
  get inputVariables(): string[] {
    const matches = [...this.template.matchAll(VAR_PATTERN)];
    return [...new Set(matches.map((m) => m[1]).filter((x): x is string => !!x))];
  }

  render(variables?: PromptVariables): string {
    const vars: PromptVariables = {
      ...(this.options?.defaultVariables ?? {}),
      ...(variables ?? {}),
    };
    const rendered = this.template.replace(VAR_PATTERN, (_match, key: string) => {
      const value = vars[key];
      return value !== undefined ? String(value) : "";
    });

    const examples = this.options?.examples;
    if (!examples || examples.length === 0) {
      return rendered;
    }

    const examplesText = examples
      .map(
        (ex, i) =>
          `Example ${i + 1}:\nInput: ${ex.input}\nOutput: ${ex.output}`,
      )
      .join("\n\n");
    return `${examplesText}\n\n${rendered}`;
  }
}

export class PromptStore {
  private prompts = new Map<string, PromptTemplate>();

  register(name: string, template: PromptTemplate): this {
    this.prompts.set(name, template);
    return this;
  }

  get(name: string): PromptTemplate | undefined {
    return this.prompts.get(name);
  }

  render(name: string, variables?: PromptVariables): string {
    const template = this.prompts.get(name);
    if (!template) {
      throw new Error(`Prompt "${name}" not found in store`);
    }
    return template.render(variables);
  }

  list(): string[] {
    return [...this.prompts.keys()];
  }
}

/**
 * 按运行时上下文选择不同变体的 prompt。例如按语言切换中英文 system prompt。
 */
export class DynamicPrompt implements PromptLike {
  private variants = new Map<string, PromptTemplate>();
  private current?: string;

  addVariant(key: string, template: PromptTemplate): this {
    this.variants.set(key, template);
    if (!this.current) this.current = key;
    return this;
  }

  use(key: string): this {
    if (!this.variants.has(key)) {
      throw new Error(`Variant "${key}" not found`);
    }
    this.current = key;
    return this;
  }

  render(variables?: PromptVariables): string {
    if (!this.current) {
      throw new Error("No variant selected");
    }
    const template = this.variants.get(this.current);
    if (!template) {
      throw new Error(`Variant "${this.current}" not found`);
    }
    return template.render(variables);
  }

  listVariants(): string[] {
    return [...this.variants.keys()];
  }
}

/**
 * 带版本管理的 prompt。可注册多版本并切换，便于 A/B 或回滚。
 */
export class VersionedPrompt implements PromptLike {
  private versions = new Map<string, PromptTemplate>();
  private current?: string;

  add(version: string, template: PromptTemplate): this {
    this.versions.set(version, template);
    if (!this.current) this.current = version;
    return this;
  }

  use(version: string): this {
    if (!this.versions.has(version)) {
      throw new Error(`Version "${version}" not found`);
    }
    this.current = version;
    return this;
  }

  render(variables?: PromptVariables): string {
    if (!this.current) {
      throw new Error("No version selected");
    }
    const template = this.versions.get(this.current);
    if (!template) {
      throw new Error(`Version "${this.current}" not found`);
    }
    return template.render(variables);
  }

  listVersions(): string[] {
    return [...this.versions.keys()];
  }
}

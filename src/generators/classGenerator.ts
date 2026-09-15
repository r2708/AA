import type { CodeContext, MethodInfo, PropertyInfo } from '../types/context';

export interface ClassMemberSpec {
  name: string;
  typeText?: string;
  optional: boolean;
}

export interface ClassGenerationOptions {
  name: string;
  members: ClassMemberSpec[];
  methods?: MethodInfo[];
  implementsName?: string;
  extendsName?: string;
  exported: boolean;
}

/** Emits a class with property declarations (TS), a constructor and stub methods. */
export function generateClassCode(ctx: CodeContext, options: ClassGenerationOptions): string {
  const isTs = ctx.language.isTypeScript;
  const semi = ctx.style.semicolons ? ';' : '';
  const q = ctx.style.quote;
  const lines: string[] = [];
  const heritage = [
    options.extendsName ? ` extends ${options.extendsName}` : '',
    options.implementsName && isTs ? ` implements ${options.implementsName}` : '',
  ].join('');
  lines.push(`${options.exported ? 'export ' : ''}class ${options.name}${heritage} {`);

  const required = options.members.filter((m) => !m.optional);
  const optional = options.members.filter((m) => m.optional);
  const ordered = [...required, ...optional];

  if (isTs && options.members.length) {
    for (const m of ordered) {
      lines.push(`\t${m.name}${m.optional ? '?' : ''}: ${m.typeText ?? 'unknown'}${semi}`);
    }
    lines.push('');
  }

  const params = ordered
    .map((m) => (isTs ? `${m.name}${m.optional ? '?' : ''}: ${m.typeText ?? 'unknown'}` : m.name))
    .join(', ');
  lines.push(`\tconstructor(${params}) {`);
  if (options.extendsName) {
    lines.push(`\t\tsuper()${semi}`);
  }
  for (const m of ordered) {
    lines.push(`\t\tthis.${m.name} = ${m.name}${semi}`);
  }
  if (!options.extendsName && ordered.length === 0) {
    lines.push('\t\t');
  }
  lines.push('\t}');

  for (const method of options.methods ?? []) {
    lines.push('');
    const p = method.parameters.map((x) => (isTs ? x.text : x.name)).join(', ');
    const ret = isTs && method.returnTypeText ? `: ${method.returnTypeText}` : '';
    lines.push(`\t${method.isAsync ? 'async ' : ''}${method.name}(${p})${ret} {`);
    lines.push(`\t\tthrow new Error(${q}Method not implemented.${q})${semi}`);
    lines.push('\t}');
  }
  lines.push('}');
  return lines.join('\n');
}

export function membersFromProperties(props: PropertyInfo[]): ClassMemberSpec[] {
  return props
    .filter((p) => !p.isStatic)
    .map((p) => ({ name: p.name, typeText: p.typeText, optional: p.optional }));
}

/** Snippet skeleton for an empty class. */
export function classSkeletonSnippet(ctx: CodeContext, defaultName: string, exported: boolean): string {
  const exp = exported ? 'export ' : '';
  const isTs = ctx.language.isTypeScript;
  const semi = ctx.style.semicolons ? ';' : '';
  if (isTs) {
    return `${exp}class \${1:${defaultName}} {\n\t\${2:private }\${3:value}: \${4:string}${semi}\n\n\tconstructor(\${3}: \${4}) {\n\t\tthis.\${3} = \${3}${semi}\n\t}\n\n\t$0\n}`;
  }
  return `${exp}class \${1:${defaultName}} {\n\tconstructor(\${2:value}) {\n\t\tthis.\${2} = \${2}${semi}\n\t}\n\n\t$0\n}`;
}

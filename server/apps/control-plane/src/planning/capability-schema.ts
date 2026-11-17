import { Type, type TSchema } from '@sinclair/typebox';

/** Converts the reviewable JSON Schema subset used by agent packages to TypeBox. */
export function toTypeBoxSchema(value: unknown): TSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('schema must be an object');
  const schema = value as Record<string, unknown>;
  const options = scalarOptions(schema);
  if (Object.hasOwn(schema, 'const')) {
    if (!isLiteral(schema.const)) throw new Error('const must be string, number or boolean');
    return Type.Literal(schema.const);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
    return Type.Union(schema.enum.map((item) => Type.Literal(item as string | number | boolean)));
  }
  switch (schema.type) {
    case 'string': return Type.String(options);
    case 'integer': return Type.Integer(options);
    case 'number': return Type.Number(options);
    case 'boolean': return Type.Boolean();
    case 'array': {
      if (!schema.items) throw new Error('array schema requires items');
      return Type.Array(toTypeBoxSchema(schema.items), options);
    }
    case 'object': {
      const sourceProperties = schema.properties;
      if (sourceProperties !== undefined && (!sourceProperties || typeof sourceProperties !== 'object' || Array.isArray(sourceProperties))) throw new Error('object properties must be an object');
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []);
      const properties = Object.fromEntries(Object.entries((sourceProperties ?? {}) as Record<string, unknown>).map(([key, nested]) => {
        const converted = toTypeBoxSchema(nested);
        return [key, required.has(key) ? converted : Type.Optional(converted)];
      }));
      const additionalProperties = schema.additionalProperties;
      if (additionalProperties !== undefined && typeof additionalProperties !== 'boolean') throw new Error('additionalProperties must be boolean');
      return Type.Object(properties, { ...options, additionalProperties });
    }
    default: throw new Error(`unsupported type ${String(schema.type)}`);
  }
}

/** Fails discovery before an incomplete declaration can be reviewed or enabled. */
export function assertSupportedCapabilitySchemas(inputSchema: unknown, resultSchema: unknown): void {
  toTypeBoxSchema(inputSchema);
  toTypeBoxSchema(resultSchema);
}

function scalarOptions(schema: Record<string, unknown>): Record<string, number | string> {
  const options: Record<string, number | string> = {};
  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'] as const) {
    const value = schema[key];
    if (value !== undefined && typeof value !== 'number') throw new Error(`${key} must be a number`);
    if (typeof value === 'number') options[key] = value;
  }
  if (schema.pattern !== undefined && typeof schema.pattern !== 'string') throw new Error('pattern must be a string');
  if (typeof schema.pattern === 'string') options.pattern = schema.pattern;
  return options;
}

function isLiteral(value: unknown): value is string | number | boolean {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

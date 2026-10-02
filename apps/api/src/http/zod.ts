import { ValidationError, type ValidationIssue } from '@flashdrop/domain';
import type { FastifySchemaCompiler, FastifySerializerCompiler, FastifyTypeProvider } from 'fastify';
import type { z } from 'zod';

/*
 * Zod as Fastify's schema language (design §11: Zod validates every body, param and query). Route schemas
 * are the `@flashdrop/contracts` DTOs themselves, so a handler sees the parsed output type (defaults and
 * transforms applied) and `reply.send` is checked against the response DTO at compile time and at runtime.
 * A small local provider instead of `fastify-type-provider-zod`, whose peer dependencies pull in
 * `@fastify/swagger`.
 */

export interface ZodTypeProvider extends FastifyTypeProvider {
  readonly validator: this['schema'] extends z.ZodType ? z.output<this['schema']> : unknown;
  readonly serializer: this['schema'] extends z.ZodType ? z.input<this['schema']> : unknown;
}

/** Zod issues as `ValidationError` issues: dotted paths relative to the validated part (body, query...). */
export function validationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/**
 * Request validation. A failure becomes a `ValidationError`, which the problem handler answers as 400
 * `VALIDATION_FAILED` with the field-level issues; Fastify adds `validationContext` (body, querystring...).
 */
export const validatorCompiler: FastifySchemaCompiler<z.ZodType> =
  ({ schema }) =>
  (data) => {
    const result = schema.safeParse(data);
    if (result.success) return { value: result.data };
    return { error: new ValidationError(validationIssues(result.error), { cause: result.error }) };
  };

/**
 * Response serialization through the DTO. Parsing (not just stringifying) means a handler can never leak a
 * column the contract does not name, and a response that breaks the contract fails loudly as a 500 here
 * instead of in a client.
 */
export const serializerCompiler: FastifySerializerCompiler<z.ZodType> =
  ({ schema }) =>
  (data) =>
    JSON.stringify(schema.parse(data));

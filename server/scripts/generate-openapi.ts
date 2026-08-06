/**
 * Generates the API reference from the running application rather than by hand.
 *
 * Every fact in `openapi.json` is read out of the app itself: the paths and methods come
 * from Nest's router, the request bodies and query parameters come from the very same Zod
 * schemas the ZodValidationPipe validates with, and the required permission comes from the
 * @RequirePermissions decorator the guard reads. So the reference cannot claim a route
 * that does not exist, a field the server would reject, or a permission it no longer
 * requires - a hand-written collection drifts the first time a schema gains a field, and
 * nothing fails when it does.
 *
 * The one thing it cannot know is response bodies: those are plain returned objects with
 * no schema to introspect. Rather than invent them, each response documents its status
 * code and, for failures, the single error envelope every non-2xx answer takes.
 *
 * Run: npm run openapi --workspace=server
 */
import 'dotenv/config';
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';
import {
  PATH_METADATA,
  METHOD_METADATA,
  HTTP_CODE_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AppModule } from '../src/app.module';
import { IS_PUBLIC } from '../src/auth/jwt-auth.guard';
import { REQUIRED_PERMISSIONS } from '../src/rbac/require-permissions.decorator';

const DEPLOYED_API = 'https://services-marketplace-bdf2.onrender.com';

/** Nest's RouteParamtypes, only the members this script cares about. */
const PARAM_BODY = 3;
const PARAM_QUERY = 4;
const PARAM_HEADERS = 6;
const PARAM_FILE = 8;

type JsonObject = Record<string, unknown>;

/**
 * Failures that cannot be inferred from a decorator, because they come from a cookie or a
 * signature rather than from the guard chain or a Zod schema.
 *
 * Deliberately only these two. `POST /auth/logout` is documented 204-always and `GET /health`
 * deliberately answers 200 with `db: "down"` rather than a 5xx, so both legitimately have no
 * failure response - an OpenAPI linter flags them, and the linter is wrong about this API.
 */
const EXTRA_RESPONSES: Record<string, Record<string, string>> = {
  'post /auth/refresh': {
    '401': 'REFRESH_INVALID - no refresh cookie, or one already rotated or revoked',
  },
  'post /payments/webhook': {
    '401': 'The HMAC signature is missing or does not match the raw body. The signature is the authentication',
    '422': 'The raw body was unavailable or the payload is malformed',
  },
};

type ArgMeta = { index: number; data?: unknown; pipes?: unknown[] };

/** A ZodValidationPipe keeps its schema on `.schema`; anything else contributes nothing. */
function schemaFromPipes(pipes: unknown[] | undefined): ZodSchema | undefined {
  for (const pipe of pipes ?? []) {
    const candidate = (pipe as { schema?: ZodSchema }).schema;
    if (candidate && typeof (candidate as { safeParse?: unknown }).safeParse === 'function') {
      return candidate;
    }
  }
  return undefined;
}

function toJsonSchema(schema: ZodSchema): JsonObject {
  // $refStrategy none because a Postman import resolves inline schemas and not $defs.
  // `as never`: zod-to-json-schema's generic signature resolves ZodSchema's recursive
  // type into TS2589 ("excessively deep"). The value is fine; only the inference is not.
  return zodToJsonSchema(schema as never, {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as JsonObject;
}

function joinPath(...parts: string[]): string {
  const joined = parts
    .map((p) => String(p ?? '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

/** `/services/:id/slots` -> `/services/{id}/slots` */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

function tagFor(controller: string): string {
  return controller.replace(/Controller$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * The description a reviewer actually needs: which permission opens the route, and
 * whether it is reachable with no token at all.
 */
function describe(isPublic: boolean, permissions: string[] | undefined): string {
  if (isPublic) return 'Public - no token required.';
  if (!permissions?.length) return 'Requires a valid access token. No additional permission.';
  const list = permissions.map((p) => `\`${p}\``).join(', ');
  return `Requires ${list}. Ownership and vendor status are enforced separately, so holding the permission is necessary but not always sufficient.`;
}

type Operation = {
  path: string;
  method: string;
  operation: JsonObject;
};

async function collect(): Promise<Operation[]> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const scanner = new MetadataScanner();
  const out: Operation[] = [];

  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;

      const prototype = Object.getPrototypeOf(instance);
      const controllerPath = (Reflect.getMetadata(PATH_METADATA, metatype) as string) ?? '';
      const controllerPublic = Reflect.getMetadata(IS_PUBLIC, metatype) === true;
      const controllerPerms = Reflect.getMetadata(REQUIRED_PERMISSIONS, metatype) as
        | string[]
        | undefined;

      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name] as (...a: unknown[]) => unknown;
        const routePath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (routePath === undefined) continue;

        const httpMethod = RequestMethod[
          Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod
        ].toLowerCase();
        const isPublic = Reflect.getMetadata(IS_PUBLIC, handler) === true || controllerPublic;
        const permissions =
          (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) as string[] | undefined) ??
          controllerPerms;
        const httpCode = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;

        const nestPath = joinPath(controllerPath, routePath);
        const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, metatype, name) ??
          {}) as Record<string, ArgMeta>;

        let bodySchema: ZodSchema | undefined;
        let querySchema: ZodSchema | undefined;
        let isMultipart = false;
        const headers: { name: string; required: boolean }[] = [];

        for (const key of Object.keys(args)) {
          const paramtype = Number(key.split(':')[0]);
          const meta = args[key];
          if (paramtype === PARAM_BODY) bodySchema ??= schemaFromPipes(meta.pipes);
          if (paramtype === PARAM_QUERY) querySchema ??= schemaFromPipes(meta.pipes);
          if (paramtype === PARAM_FILE) isMultipart = true;
          if (paramtype === PARAM_HEADERS && typeof meta.data === 'string') {
            headers.push({
              name: meta.data,
              // The server rejects a write without it, so it is not optional in practice.
              required: meta.data.toLowerCase() === 'idempotency-key',
            });
          }
        }

        const parameters: JsonObject[] = [
          ...pathParamNames(nestPath).map((p) => ({
            name: p,
            in: 'path',
            required: true,
            schema: { type: 'string' },
          })),
          ...headers.map((h) => ({
            name: h.name,
            in: 'header',
            required: h.required,
            schema: { type: 'string' },
            description:
              h.name.toLowerCase() === 'idempotency-key'
                ? 'Any unique string. Replaying the same key with the same body replays the stored response instead of performing the effect twice; the same key with a different body is a 409.'
                : undefined,
          })),
        ];

        // A query schema is a flat object, so each of its properties becomes one query
        // parameter - which is what a reviewer can actually fill in, rather than a blob.
        if (querySchema) {
          const json = toJsonSchema(querySchema);
          const props = (json.properties ?? {}) as Record<string, JsonObject>;
          const required = (json.required ?? []) as string[];
          for (const [propName, propSchema] of Object.entries(props)) {
            parameters.push({
              name: propName,
              in: 'query',
              required: required.includes(propName),
              schema: propSchema,
            });
          }
        }

        const responses: JsonObject = {
          [String(httpCode ?? (httpMethod === 'post' ? 201 : 200))]: { description: 'Success' },
        };
        if (!isPublic) {
          responses['401'] = errorResponse('No token, an expired one, or an invalid one');
          responses['403'] = errorResponse(
            'The permission, ownership or vendor-status gate refused the caller',
          );
        }
        if (pathParamNames(nestPath).length) {
          responses['404'] = errorResponse(
            'Not found - also the answer for a resource that exists but is hidden from this caller',
          );
        }
        if (bodySchema || querySchema) {
          responses['422'] = errorResponse(
            'Validation failed. Schemas are strict, so an unexpected key is a 422 rather than being ignored',
          );
        }

        // A route taking a required Idempotency-Key has two failures no schema implies:
        // the header absent at all, and the same key replayed with a different body.
        if (headers.some((h) => h.required)) {
          responses['400'] = errorResponse(
            'IDEMPOTENCY_KEY_REQUIRED - the header is absent. 400 rather than 422 because there is no body field to fault',
          );
          responses['409'] = errorResponse(
            'IDEMPOTENCY_KEY_REUSED - the same key arrived with a different request body',
          );
        }

        for (const [status, description] of Object.entries(
          EXTRA_RESPONSES[`${httpMethod} ${toOpenApiPath(nestPath)}`] ?? {},
        )) {
          responses[status] = errorResponse(description);
        }

        const operation: JsonObject = {
          tags: [tagFor(metatype.name)],
          summary: `${metatype.name}.${name}`,
          description: describe(isPublic, permissions),
          operationId: `${metatype.name}_${name}`,
          responses,
        };
        if (parameters.length) operation.parameters = parameters;
        if (isPublic) operation.security = [];
        if (bodySchema) {
          operation.requestBody = {
            required: true,
            content: { 'application/json': { schema: toJsonSchema(bodySchema) } },
          };
        } else if (isMultipart) {
          operation.requestBody = {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: { file: { type: 'string', format: 'binary' } },
                  required: ['file'],
                },
              },
            },
          };
        }

        out.push({ path: toOpenApiPath(nestPath), method: httpMethod, operation });
      }
    }
  }

  await app.close();
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function errorResponse(description: string): JsonObject {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
}

async function main(): Promise<void> {
  const operations = await collect();

  const paths: Record<string, JsonObject> = {};
  for (const { path, method, operation } of operations) {
    paths[path] ??= {};
    paths[path][method] = operation;
  }

  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'Services Marketplace API',
      version: '1.0.0',
      description: [
        'Generated from the running application - paths from the Nest router, request',
        'bodies and query parameters from the Zod schemas the server validates with, and',
        'the required permission from the decorator the guard reads. Regenerate with',
        '`npm run openapi --workspace=server`.',
        '',
        '**Authentication.** `POST /auth/login` returns a short-lived access token in the body',
        'and sets an httpOnly refresh cookie. Send the access token as `Authorization: Bearer',
        '<token>`. Every seeded account uses the password in the README.',
        '',
        '**Errors.** Every non-2xx response is `{ error: { code, message, details?, requestId } }`.',
        'The `code` is stable and machine-readable; the HTTP status says what kind of failure it',
        'is. A refusal by permission is 403, an illegal state transition is 422, and a full slot',
        'is 409 - three different problems that a single 400 would flatten.',
      ].join('\n'),
    },
    servers: [
      { url: DEPLOYED_API, description: 'Deployed API (free tier - the first request may take 30-50s to wake it)' },
      { url: 'http://localhost:3000', description: 'Local' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string', example: 'FORBIDDEN' },
                message: { type: 'string' },
                details: {},
                requestId: { type: 'string' },
              },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };

  const target = join(__dirname, '..', '..', 'openapi.json');
  writeFileSync(target, `${JSON.stringify(spec, null, 2)}\n`);

  console.log(`${operations.length} operations across ${Object.keys(paths).length} paths`);
  console.log(`wrote ${target}`);

  const withBody = operations.filter((o) => o.operation.requestBody).length;
  const withParams = operations.filter((o) => o.operation.parameters).length;
  console.log(`${withBody} document a request body, ${withParams} document parameters`);
}

void main();

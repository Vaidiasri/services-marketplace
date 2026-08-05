/**
 * The guard against the highest-risk failure in the permission layer: a protected route
 * that carries no decorator is silently public.
 *
 * Public is opt-in by omission in PermissionsGuard - a route declaring no required
 * permissions is allowed through. That is the right default for genuinely public reads,
 * and it means one forgotten @RequirePermissions ships an open admin endpoint that no
 * integration test would notice, because nobody writes a test asserting a route they
 * forgot to protect.
 *
 * So this enumerates every route Nest actually registered and fails unless each one is
 * accounted for. It reads the router, not the source, so a route added anywhere is
 * caught without touching this file.
 *
 * Run: npm run test:routes --workspace=server
 */
import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { IS_PUBLIC } from '../src/auth/jwt-auth.guard';
import { REQUIRED_PERMISSIONS } from '../src/rbac/require-permissions.decorator';

/**
 * Routes that legitimately carry neither decorator, each with the reason it is safe.
 *
 * Deliberately a list of exact `METHOD path` strings rather than prefixes or patterns:
 * an allowlist of `/auth/*` would silently cover a future `/auth/impersonate`.
 */
const ALLOWLIST: Record<string, string> = {
  'GET /health':
    'Platform health check. Carries no token, and a 401 here makes Render mark a healthy service failed.',
  'GET /me':
    'Authenticated but permission-free by design: every signed-in user may ask who they are. JwtAuthGuard still requires a valid token.',
};

type Route = {
  key: string;
  controller: string;
  handler: string;
  isPublic: boolean;
  permissions: string[] | undefined;
};

function joinPath(...parts: string[]): string {
  const joined = parts
    .map((p) => String(p ?? '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

function methodName(method: RequestMethod): string {
  return RequestMethod[method] ?? String(method);
}

async function collectRoutes(): Promise<Route[]> {
  // logger: false keeps Nest's boot output from drowning the result. abortOnError so a
  // wiring mistake fails the test rather than producing an empty route list that
  // trivially "passes".
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const scanner = new MetadataScanner();
  const routes: Route[] = [];

  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;

      const prototype = Object.getPrototypeOf(instance);
      const controllerPath = Reflect.getMetadata(PATH_METADATA, metatype) ?? '';
      const controllerPublic =
        Reflect.getMetadata(IS_PUBLIC, metatype) === true;
      const controllerPerms = Reflect.getMetadata(REQUIRED_PERMISSIONS, metatype);

      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name];
        const routePath = Reflect.getMetadata(PATH_METADATA, handler);
        // No PATH_METADATA means it is a helper, not a route handler.
        if (routePath === undefined) continue;

        const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler);
        const methodPublic = Reflect.getMetadata(IS_PUBLIC, handler) === true;
        const methodPerms = Reflect.getMetadata(REQUIRED_PERMISSIONS, handler);

        routes.push({
          key: `${methodName(httpMethod)} ${joinPath(controllerPath, routePath)}`,
          controller: metatype.name,
          handler: name,
          // Method-level metadata wins, matching getAllAndOverride in both guards.
          isPublic: methodPublic || controllerPublic,
          permissions: methodPerms ?? controllerPerms,
        });
      }
    }
  }

  await app.close();
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}

async function main(): Promise<void> {
  const routes = await collectRoutes();

  if (routes.length === 0) {
    console.error('FAIL  no routes discovered - the scan is broken, not the app');
    process.exit(1);
  }

  const unprotected: Route[] = [];
  const staleAllowlist = new Set(Object.keys(ALLOWLIST));

  for (const r of routes) {
    const allowed = r.key in ALLOWLIST;
    staleAllowlist.delete(r.key);

    const covered = r.isPublic || (r.permissions?.length ?? 0) > 0 || allowed;
    const label = r.isPublic
      ? 'public'
      : r.permissions?.length
        ? r.permissions.join(', ')
        : allowed
          ? 'allowlisted'
          : 'NOTHING';

    console.log(
      `${covered ? 'PASS' : 'FAIL'}  ${r.key.padEnd(38)} ${label}` +
        `${covered ? '' : `   <- ${r.controller}.${r.handler}`}`,
    );

    if (!covered) unprotected.push(r);
  }

  console.log(`\n${routes.length} routes registered`);

  let failed = false;

  if (unprotected.length) {
    failed = true;
    console.error(
      `\n${unprotected.length} route(s) carry neither @Public() nor @RequirePermissions ` +
        `and are not allowlisted. Each one is reachable without a permission check:`,
    );
    for (const r of unprotected) {
      console.error(`  ${r.key}  (${r.controller}.${r.handler})`);
    }
    console.error(
      '\nAdd @RequirePermissions(...) if it is protected, @Public() if it genuinely is ' +
        'not, or an ALLOWLIST entry with the reason it needs neither.',
    );
  }

  // A stale allowlist entry means a route was renamed or removed and the exemption
  // outlived it. Left alone, the allowlist slowly becomes a list of paths nobody has
  // checked in months.
  if (staleAllowlist.size) {
    failed = true;
    console.error(
      `\n${staleAllowlist.size} stale ALLOWLIST entr(ies) match no registered route:`,
    );
    for (const key of staleAllowlist) console.error(`  ${key}`);
  }

  process.exit(failed ? 1 : 0);
}

void main();

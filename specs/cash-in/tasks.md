# Tasks · Wallet Cash-In

> Tareas atómicas en orden de ejecución. Cada una cita los requisitos de [requirements.md](requirements.md) que cubre.
> Cada tarea tiene su plan en [plans/](plans/), dentro de la carpeta de su fase: `plans/fase-<n>/T<id>-<slug>.md`. El plan se escribe antes de implementar.
> Una tarea se marca hecha solo cuando sus tests pasan. Un commit por tarea.
> Las rutas siguen la estructura Feature-First de [AGENTS.md](../../AGENTS.md#estructura-feature-first).

## Fase 1 · Specs y repositorio

- [x] 1.1 Escribir `requirements.md`, `design.md` y `tasks.md`.
- [x] 1.2 Iniciar `docs/ai-log.md`.
- [x] 1.3 `AGENTS.md` como fuente única de reglas, con `CLAUDE.md` y `GEMINI.md` que lo importan.
- [x] 1.4 Carpeta `specs/cash-in/plans/` con su plantilla.
- [x] 1.5 `git init` con rama `main`, `.gitignore` y primer commit.
- [x] 1.6 Crear el repositorio público en GitHub con `gh repo create` y hacer push.
- [x] 1.7 Revisión y aprobación de los specs por el usuario.

## Fase 2 · Base

- [x] 2.1 `package.json` con Bun, Hono, Prisma, ioredis, pino, zod y `@hono/zod-validator`. Scripts `dev`, `typecheck`, `test:unit`, `test:int`, `test:e2e`, `db:seed`. `tsconfig.json` estricto. — R14
- [x] 2.2 `docker-compose.yml` con `postgres` y `redis`, y `.env.example`. — R14.3
- [x] 2.3 `prisma/schema.prisma` según design §10, primera migración y seed de wallets. — R8, R14.1
- [x] 2.4 `src/infra/config.ts` con validación zod de variables de entorno. — design §13
- [x] 2.5 `src/infra/logger.ts` y `src/infra/correlation.ts`. — R13
- [x] 2.6 `src/app.ts` como factory de la app Hono con dependencias inyectadas, `src/server.ts` y `src/features/health/`. — R14

## Fase 3 · Dominio puro

- [x] 3.1 `src/shared/operation-state-machine.ts` con `canTransition` y `allowedSources`. Test unitario. — R7
- [x] 3.2 `src/shared/errors.ts` con `AppError` y el catálogo, y `src/shared/error-handler.ts`. Test unitario. — R12
- [x] 3.3 `src/features/cash-in/cash-in.request-hash.ts`. Test unitario. — R2.4, R2.5
- [x] 3.4 `src/shared/retry.ts` con backoff y jitter. Test unitario. — R6.3
- [x] 3.5 `src/features/webhooks/webhooks.signature.ts`. Test unitario. — R9.2
- [x] 3.6 `cash-in.schemas.ts` y `webhooks.schemas.ts` con zod, más el hook que los traduce a `AppError`. Test unitario de cada regla y de `.strict()`. — R1.3 a R1.6, R2.1, R2.2, R9.3

## Fase 4 · Cash-in

- [x] 4.1 `src/infra/payment-provider/` con el puerto y `FakePaymentProvider` idempotente por referencia. Test unitario. — R5.2
- [x] 4.2 `src/infra/lock.ts` con `ownerId`, liberación con Lua y fallback si Redis falla. Test de integración. — R3, R4.3, R4.4
- [ ] 4.3 `cash-in.repository.ts`: create con `P2002`, `findByKey` y CAS con `updateMany`. — R2, R7.4
- [ ] 4.4 `withDbRetry` en `src/shared/` para errores transitorios de Prisma. — R11
- [ ] 4.5 `applyCredit` en `src/features/wallet/wallet.service.ts`. — R8
- [ ] 4.6 `cash-in.service.ts` según design §3. Test unitario con dobles. — R1, R5, R6
- [ ] 4.7 `cash-in.routes.ts` con `zValidator` de header y body, y mapeo a HTTP. — R1, R2, R12
- [ ] 4.8 `cash-in.int.test.ts` de idempotencia, concurrencia, éxito, fallo, timeout y saldo. — R2 a R8

## Fase 5 · Webhooks

- [ ] 5.1 `webhooks.service.ts` según design §6, en una sola transacción. — R9
- [ ] 5.2 `webhooks.routes.ts`: firma sobre el body crudo y luego validación zod del payload. — R9.1 a R9.3
- [ ] 5.3 `webhooks.int.test.ts` de duplicado, fuera de orden, antes de la respuesta, monto distinto y error transitorio. — R9

## Fase 6 · Reconciliador

- [ ] 6.1 `src/features/reconciliation/reconciliation.service.ts` con lease vía `updateMany`. — R10
- [ ] 6.2 `reconciliation.int.test.ts` con dos reconciliadores concurrentes y caso `not_found`. — R10.4, R10.5

## Fase 7 · E2E

- [ ] 7.1 `tools/mock-psp/` y `src/infra/payment-provider/http.provider.ts`. — design §11
- [ ] 7.2 `Dockerfile` de la app y perfil `e2e` con `app1`, `app2`, `nginx` y `mock-psp`. — R4
- [ ] 7.3 `tests/e2e/` según el plan de verificación. — R14.2

## Fase 8 · Terraform

- [x] 8.1 `infra/terraform/` con red, ALB, ECS, RDS, ElastiCache, Secrets Manager y CloudWatch. — R14.3
- [x] 8.2 `terraform fmt -check` y `terraform validate`.

## Fase 9 · Documentación

- [ ] 9.1 `README.md` con arquitectura, idempotencia, concurrencia, retry, webhooks, cómo correr y respuestas a la defensa técnica. — R14.4
- [ ] 9.2 Cerrar `docs/ai-log.md` con los prompts y las correcciones reales.

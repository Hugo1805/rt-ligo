# AGENTS.md

Reglas para todo agente de IA que trabaje en este repo: Claude Code, Gemini o Antigravity.
Este archivo es la única fuente de reglas. `CLAUDE.md` y `GEMINI.md` solo lo importan.

## Proyecto

Servicio de Cash-In para una wallet en PEN. Es el challenge Backend Senior de Ligo.
Lo crítico es no cobrar dos veces y no acreditar dos veces, con N pods concurrentes.

## Fuente de verdad

Orden de precedencia. Si dos documentos se contradicen, gana el de arriba y se reporta la contradicción.

1. [specs/cash-in/requirements.md](specs/cash-in/requirements.md): qué debe cumplir el sistema.
2. [specs/cash-in/design.md](specs/cash-in/design.md): cómo se cumple.
3. [specs/cash-in/tasks.md](specs/cash-in/tasks.md): orden de trabajo.
4. [specs/cash-in/plans/](specs/cash-in/plans/): plan detallado de cada tarea, en una carpeta por fase.
5. Este archivo.

No implementes nada que no esté en los specs. Si falta algo, detente y propón el cambio en el spec primero.

## Flujo de trabajo (SDD)

1. Toma la siguiente tarea sin marcar de `tasks.md`.
2. Lee su plan en `specs/cash-in/plans/fase-<n>/T<id>-*.md`, donde `<n>` es la fase de la tarea. Si no existe, escríbelo primero con la plantilla de [specs/cash-in/plans/README.md](specs/cash-in/plans/README.md).
3. Implementa solo lo que dice el plan. Nada fuera de "Archivos" sin avisar.
4. Corre los tests indicados en el plan. Todos deben pasar.
5. Deja el plan en estado `review` y marca sus criterios de aceptación. No hagas commit: el ejecutor entrega el diff sin commitear.
6. Quien revisa compara el diff con el plan, corrige, y si el agente se equivocó agrega la entrada en [docs/ai-log.md](docs/ai-log.md).
7. Quien revisa marca la tarea en `tasks.md`, pasa el plan a `done` y hace un commit por tarea.

## Stack

| Pieza | Herramienta |
|---|---|
| Runtime y package manager | Bun |
| HTTP | Hono |
| Validación | zod con `@hono/zod-validator` |
| ORM y migraciones | Prisma |
| Base de datos | PostgreSQL 16 |
| Lock rápido | Redis 7 con ioredis |
| Logs | pino en JSON |
| Tests | `bun:test` |
| Entorno local | Docker Compose |
| Infraestructura | Terraform sobre AWS |

No agregues dependencias fuera de esta tabla sin justificarlo en el plan de la tarea.

## Estructura: Feature-First

El código se organiza por feature, no por capa técnica. Todo lo de una feature vive en su carpeta.

```
src/
  features/
    cash-in/          POST /cash-in, huella, repositorio de operaciones
    webhooks/         POST /webhooks/payment, firma, dedupe de eventos
    wallet/           applyCredit, ledger, repositorio de wallets
    reconciliation/   reconciliador con lease
    health/           GET /health
  shared/             errores, error handler, retry, dinero y máquina de estados de la operación. Sin IO.
  infra/              config, prisma, redis, lock, logger, correlation ID, payment-provider
  app.ts              factory de la app Hono con dependencias inyectadas
  server.ts           arranque
prisma/               schema, migraciones, seed
tests/
  unit/               tests unitarios; replican la ruta de src/ y tools/
  integration/        tests con Postgres y Redis reales; replican la ruta de src/
  e2e/                tests HTTP contra 2 réplicas
  helpers/            factories, firma de webhooks, limpieza de DB
tools/mock-psp/       proveedor de pagos falso para e2e
infra/terraform/      AWS
```

Convención de nombres dentro de una feature, con `cash-in` como ejemplo:

| Archivo | Contenido |
|---|---|
| `cash-in.routes.ts` | Rutas Hono. Solo HTTP: validar, llamar al servicio, mapear a respuesta. |
| `cash-in.schemas.ts` | Schemas zod y tipos con `z.infer`. |
| `cash-in.service.ts` | Orquestación del caso de uso. |
| `cash-in.repository.ts` | Acceso a datos con el cliente Prisma. |
| `tests/unit/features/cash-in/cash-in.<rol>.unit.test.ts` | Tests unitarios, fuera de `src/`. |
| `tests/integration/features/cash-in/cash-in.<rol>.int.test.ts` | Tests de integración, fuera de `src/`. |

Reglas de dependencia:
- Una feature puede importar de `shared/` e `infra/`.
- `shared/` e `infra/` nunca importan de `features/`.
- Una feature solo importa de otra a través de su archivo `<feature>.service.ts`. Hoy `wallet.service.ts` expone `applyCredit` y `getWallet`.
- La máquina de estados vive en `src/shared/operation-state-machine.ts` porque es pura y la usan cash-in, webhooks y el reconciliador.
- Las rutas nunca llaman a Prisma directo.

## Reglas no negociables

**Idempotencia y concurrencia**
- La garantía final está en PostgreSQL: restricciones únicas y compare-and-set. Redis es solo una barrera rápida.
- Nunca guardes estado de idempotencia en memoria del proceso: ni `Map`, ni caché local, ni variables de módulo.
- Todo debe ser correcto con N pods y con Redis caído.
- La operación se persiste antes de llamar al proveedor.
- Al proveedor se le envía siempre `reference = operation_id`. Nunca generes una referencia nueva para una operación existente.

**Acceso a datos**
- Solo cliente Prisma y Prisma Migrate. Prohibido `$queryRaw`, `$executeRaw` y SQL a mano.
- Transiciones de estado con `updateMany` filtrando por estado de origen, y chequeo de `count`.
- Saldo con `{ increment }`. Nunca leas el saldo para escribirlo después.
- Abono, transición a `COMPLETED` y asiento en el ledger van en la misma `$transaction`.
- Detecta duplicados capturando `P2002`, no con un `find` previo.

**Dinero**
- Montos en DB como `Decimal(18,2)`. Aritmética con `Prisma.Decimal`, nunca con `number`.
- Solo PEN.

**Errores**
- Todo error sale como `application/problem+json` por el error handler global.
- Lanza `AppError` con un `code` del catálogo de `design.md`. No inventes códigos sin agregarlos al spec.
- Nunca expongas stack traces ni mensajes de Prisma o del proveedor.

**Validación**
- Toda entrada se valida con zod antes de cualquier efecto: headers, body, payload de webhook y variables de entorno.
- Los schemas de body de nuestra API usan `.strict()`. El payload del webhook es la excepción: descarta campos desconocidos sin fallar, para que un campo nuevo del proveedor no provoque reintentos infinitos.

**Retry**
- Nunca reintentes un rechazo de negocio del proveedor.
- Reintentos técnicos solo con la misma referencia, backoff exponencial con jitter y tope.
- Un timeout del proveedor deja la operación `UNKNOWN`. No se reintenta en línea.

**Observabilidad**
- Usa el logger del contexto del request, que ya trae `request_id`. No uses `console.log`.
- Loguea cada transición con `operation_id`, `from`, `to` y `actor`.

## Tests

| Nivel | Ubicación | Dependencias | Comando |
|---|---|---|---|
| Unitario | `tests/unit/**/*.unit.test.ts` | Ninguna | `bun run test:unit` |
| Integración | `tests/integration/**/*.int.test.ts` | Postgres y Redis de Docker Compose | `bun run test:int` |
| E2E | `tests/e2e/*.e2e.test.ts` | Perfil `e2e` de Docker Compose | `bun run test:e2e` |

- Importa siempre desde `bun:test`. Jest no se usa.
- Ningún test vive en `src/`. Cada test replica en `tests/unit/` o `tests/integration/` la ruta del código que prueba: `src/shared/retry.ts` se prueba en `tests/unit/shared/retry.unit.test.ts`.
- La idempotencia y la concurrencia se prueban en integración o e2e con Postgres y Redis reales, nunca solo con dobles en memoria.
- Un test de concurrencia lanza los requests con `Promise.all` desde instancias separadas del servicio, cada una con su propio cliente Prisma y Redis.
- Cada test deja la DB limpia o usa datos únicos.

## Comandos

```bash
docker compose up -d postgres redis
bun install
bunx prisma migrate dev
bun run db:seed
bun run dev
bun run test:unit
bun run test:int
docker compose --profile e2e up -d --build && bun run test:e2e
bun run typecheck
```

## Git

- Rama principal `main`. Repo público en GitHub.
- El commit lo hace quien revisa, nunca el agente ejecutor.
- Un commit por tarea con Conventional Commits y el id de la tarea: `feat(cash-in): crear operación idempotente [T4.3]`.
- Tipos: `feat`, `fix`, `test`, `docs`, `chore`, `refactor`, `infra`.
- No hagas commit con tests rojos.
- No subas `.env`, secretos ni el PDF del challenge.

## Definition of Done

Una tarea está hecha cuando:
- Cumple los criterios de aceptación de su plan.
- Sus tests pasan y `bun run typecheck` no da errores.
- No rompe ninguna regla no negociable.
- `tasks.md` y el plan están actualizados.
- Si hubo correcciones al agente, están en `docs/ai-log.md`.

## Idioma

Specs, README, plans y bitácora en español. Código, nombres de archivos, identificadores y mensajes de commit en inglés, salvo la descripción del commit que puede ir en español.

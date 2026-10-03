# Wallet Cash-In · Challenge Backend Senior Ligo

Servicio de recarga de saldo en PEN a través de una pasarela de pagos externa. Su objetivo es no cobrar dos veces ni acreditar dos veces, con N pods concurrentes, reintentos del cliente, timeouts del proveedor y webhooks duplicados o fuera de orden.

Se construyó con spec-driven development y agentes de IA, en las 39 tareas de [tasks.md](specs/cash-in/tasks.md), todas cerradas.

## Contenido

1. [Arquitectura](#arquitectura)
2. [Idempotencia en dos capas](#idempotencia-en-dos-capas)
3. [Concurrencia y saldo](#concurrencia-y-saldo)
4. [Retry y resiliencia](#retry-y-resiliencia)
5. [Webhooks](#webhooks)
6. [Formato de error](#formato-de-error)
7. [Cómo correr](#cómo-correr)
8. [Tests](#tests)
9. [Defensa técnica](#defensa-técnica)
10. [Pilotaje y orquestación de agentes IA](#pilotaje-y-orquestación-de-agentes-ia)
11. [Decisiones y límites conocidos](#decisiones-y-límites-conocidos)

| Documento | Contenido |
|---|---|
| [requirements.md](specs/cash-in/requirements.md) | Qué debe cumplir el sistema, en formato EARS. |
| [design.md](specs/cash-in/design.md) | Arquitectura, idempotencia, máquina de estados, webhooks, errores, datos. |
| [tasks.md](specs/cash-in/tasks.md) y [plans/](specs/cash-in/plans/) | Tareas y el plan ejecutable de cada una, con sus notas de revisión. |
| [AGENTS.md](AGENTS.md) | Reglas para todos los agentes. |
| [docs/ai-log.md](docs/ai-log.md) | Qué se le pidió al agente y qué se corrigió. |
| [docs/orchestration.md](docs/orchestration.md) | Cómo se orquestaron Claude Code, Antigravity y Gemini. |

## Arquitectura

```mermaid
flowchart LR
  APP[App móvil] -->|POST /cash-in| LB[ALB / nginx]
  PSP[Proveedor de pagos] -->|POST /webhooks/payment| LB
  LB --> P1[Pod 1]
  LB --> P2[Pod N]
  P1 & P2 --> PG[(PostgreSQL<br/>fuente de verdad)]
  P1 & P2 --> RD[(Redis<br/>lock rápido)]
  P1 & P2 -->|charge / getCharge<br/>con referencia = operation_id| PSP
  REC[Reconciliador<br/>en cada pod] --> PG
  REC --> PSP
```

Stack: Bun, Hono, zod, Prisma 7 con `@prisma/adapter-pg`, PostgreSQL 16, Redis 7, pino, `bun:test`, Docker Compose y Terraform sobre AWS.

El código es Feature-First. Los tests viven fuera de `src/`, en `tests/`, y replican la ruta del código que prueban.

| Carpeta | Contenido |
|---|---|
| [src/features/cash-in/](src/features/cash-in/) | `POST /cash-in`: rutas, schemas, servicio, repositorio de operaciones y huella del request. |
| [src/features/webhooks/](src/features/webhooks/) | `POST /webhooks/payment`: firma HMAC, schema, servicio y repositorio de eventos. |
| [src/features/wallet/](src/features/wallet/) | `applyCredit` y `getWallet`. Única puerta para acreditar. |
| [src/features/reconciliation/](src/features/reconciliation/) | Reconciliador con lease. |
| [src/features/health/](src/features/health/) | `GET /health`. |
| [src/shared/](src/shared/) | `AppError` y catálogo, error handler, `retry`, `withDbRetry`, máquina de estados, validación. |
| [src/infra/](src/infra/) | Config, Prisma, Redis, lock, logger, correlation ID y adaptadores del proveedor. |
| [tools/mock-psp/](tools/mock-psp/) | Proveedor de pagos falso como servicio HTTP, para e2e. |
| [infra/terraform/](infra/terraform/) | VPC, ALB, ECS Fargate, RDS, ElastiCache, Secrets Manager y CloudWatch. |
| [tests/](tests/) | `unit/`, `integration/`, `e2e/` y `helpers/`. |

`createApp(deps)` en [src/app.ts](src/app.ts) recibe Prisma, Redis, lock y proveedor ya construidos. Así los tests levantan varias apps en un mismo proceso, cada una con sus propios clientes, para simular pods.

## Idempotencia en dos capas

Detalle en [design §2](specs/cash-in/design.md#2-idempotencia-en-dos-capas--r2-r3-r4).

1. **Redis, barrera rápida.** [src/infra/lock.ts](src/infra/lock.ts) hace `SET lock:cashin:<user>:<key> <ownerId> NX PX 15000`. El `ownerId` es un UUID nuevo por cada `acquire`. Se libera con un script Lua de compare-and-delete, así un pod cuyo lock venció no borra el de otro. Si Redis falla, `acquire` devuelve `unavailable` en a lo sumo 1 s y el flujo sigue sin lock.
2. **PostgreSQL, la garantía.** `@@unique([userId, idempotencyKey])` en `CashInOperation`. Solo un `create` gana. El perdedor captura `P2002` y devuelve la operación existente ([cash-in.repository.ts](src/features/cash-in/cash-in.repository.ts)). Nunca hay un `find` previo para "ver si existe".
3. **Huella del request.** SHA-256 del JSON canónico de `user_id`, `amount` (normalizado con `Prisma.Decimal` a 2 decimales), `currency` y `payment_method` ([cash-in.request-hash.ts](src/features/cash-in/cash-in.request-hash.ts)). La misma key con otro body responde `422 IDEMPOTENCY_KEY_REUSED`.

Una respuesta repetida lleva `Idempotent-Replayed: true` y el mismo cuerpo, incluido `new_balance`, que sale del asiento del ledger y no del saldo actual.

## Concurrencia y saldo

Detalle en [design §4 y §5](specs/cash-in/design.md#4-máquina-de-estados--r7).

- **Máquina de estados** en [src/shared/operation-state-machine.ts](src/shared/operation-state-machine.ts): `PENDING → PROCESSING → COMPLETED | FAILED | UNKNOWN` y `UNKNOWN → COMPLETED | FAILED`. `COMPLETED` y `FAILED` son terminales. La tabla está congelada con `Object.freeze`.
- **Compare-and-set** en cada transición: `updateMany({ where: { id, status: { in: allowedSources(to) } } })` y chequeo de `count`. Si da 0, otro actor ganó: se relee y se responde el estado real, nunca se lanza.
- **`applyCredit`** en [wallet.service.ts](src/features/wallet/wallet.service.ts), en una sola `$transaction`:
  1. CAS a `COMPLETED`.
  2. `wallet.update({ balance: { increment } })`, una sola sentencia que toma el lock de fila.
  3. `ledgerEntry.create` con `balanceAfter` salido de ese `update`.

  `LedgerEntry.operationId @unique` es la última red contra un doble abono. `userId` y `amount` se leen de la operación dentro de la transacción, nunca del llamador.

## Retry y resiliencia

Detalle en [design §7](specs/cash-in/design.md#7-retry-y-resiliencia--r6-r10-r11).

**Hacia el proveedor**, en [cash-in.service.ts](src/features/cash-in/cash-in.service.ts):

| Resultado | Acción |
|---|---|
| `succeeded` | `applyCredit`. |
| `declined` | CAS a `FAILED`. Sin reintento. |
| `ProviderUnavailableError` (red, 5xx) | Hasta 2 reintentos con full jitter (base 100 ms, cap 1 s), siempre con la misma referencia. Agotados, `UNKNOWN`. |
| `ProviderTimeoutError` (3 s) | `UNKNOWN`, sin reintento en línea. |
| `ProviderUnexpectedError` u otro error | `UNKNOWN`, sin reintento. Nunca `FAILED` sin certeza de que no cobró. |

**Hacia PostgreSQL**, en [src/shared/db-retry.ts](src/shared/db-retry.ts): `withDbRetry` reintenta la unidad de trabajo completa, hasta 3 intentos, y al agotarlos lanza `503 SERVICE_UNAVAILABLE` con `Retry-After`. Reconoce los códigos de Prisma de design §7 y además las formas reales que produce `@prisma/adapter-pg` cuando Postgres se cae: `code: "ECONNREFUSED"` y el error de timeout del pool de `pg`. Esas formas se descubrieron probando contra una base caída ([ai-log #19](docs/ai-log.md)). El cliente `pg` tiene un timeout de conexión de 2 s, así un host que no responde no cuelga el request.

**Reconciliador** en [reconciliation.service.ts](src/features/reconciliation/reconciliation.service.ts). Corre en cada pod:
- Busca operaciones `PENDING`, `PROCESSING` o `UNKNOWN` viejas y reclama cada una con un lease vía `updateMany` sobre `leaseOwner` y `leaseUntil`, que solo gana un pod.
- Una `PENDING` se cobra con la misma referencia, porque el cobro nunca salió.
- Las demás se consultan con `getCharge(reference)`. Si da `not_found`, se reenvía `charge` con la misma referencia.
- Tras `RECONCILE_MAX_ATTEMPTS` intentos deja la operación `UNKNOWN` y emite `reconcile.exhausted`.

## Webhooks

Detalle en [design §6](specs/cash-in/design.md#6-webhooks--r9).

1. [webhooks.routes.ts](src/features/webhooks/webhooks.routes.ts) lee el body crudo y verifica `X-Provider-Signature: t=..,v1=..`. Usa HMAC-SHA256 con `timingSafeEqual` y una tolerancia de 300 s hacia el pasado y hacia el futuro. Si falla, responde `401` sin tocar la DB. Recién después parsea y valida con zod.
2. [webhooks.service.ts](src/features/webhooks/webhooks.service.ts) hace todo en una `$transaction`: inserta el `WebhookEvent` (`providerEventId @unique`), busca la operación, valida monto y moneda, aplica la transición y cierra el evento con su `outcome`.
3. Si el insert da `P2002`, el evento es un duplicado y se responde `200 { duplicate: true }`. Como el dedupe va en la misma transacción que el efecto, un fallo intermedio revierte también el insert. Se responde 5xx y el reintento del proveedor lo procesa de cero.

| Estado actual | `charge.succeeded` | `charge.failed` |
|---|---|---|
| `PROCESSING`, `UNKNOWN` | `COMPLETED` + abono | `FAILED` |
| `COMPLETED` | No-op | Ignorado y logueado (fuera de orden) |
| `FAILED` | Ignorado, log `error` (anomalía) | No-op |

Si el webhook llega antes que la respuesta síncrona, el webhook acredita y el CAS del flujo síncrono da 0. El pod relee y responde `200 completed` con el mismo `new_balance` (R9.8). Está probado en integración y apareció de punta a punta en e2e ([ai-log #23](docs/ai-log.md)).

## Formato de error

Todos los errores salen como `application/problem+json` por un único handler ([src/shared/error-handler.ts](src/shared/error-handler.ts)). El catálogo de códigos está en [design §9](specs/cash-in/design.md#9-formato-de-error--r12).

```json
{
  "type": "https://errors.ligo.pe/cash-in/idempotency-key-reused",
  "title": "Idempotency-Key reutilizada con otro payload",
  "status": 422,
  "code": "IDEMPOTENCY_KEY_REUSED",
  "detail": "Idempotency-Key reutilizada con otro payload",
  "request_id": "c10492a9-7ec5-40eb-bb00-3feccfa50369",
  "retryable": false,
  "errors": [],
  "operation_id": "op_01a0ffa6887c7000af414a5d25557597"
}
```

`request_id` coincide con el header `X-Request-Id` y con los logs. El body nunca incluye stack traces ni mensajes de Prisma o del proveedor.

## Cómo correr

Requisitos: Bun 1.3+, Docker y, solo para `infra:check`, Terraform.

```bash
cp .env.example .env
cp .env.test.example .env.test
docker compose up -d postgres redis
bun install
bun run db:migrate                     # crea la base cashin y aplica la migración
bun run db:generate                    # cliente Prisma en src/generated (Prisma 7 no lo genera al migrar)
bun run db:seed                        # usr_abc123 con 250.00, usr_test_1 y usr_test_2 con 0.00
DATABASE_URL=postgresql://cashin:cashin@localhost:5432/cashin_test bun run db:deploy
bun run dev                            # http://localhost:3000
```

Ejemplo del PDF:

```bash
curl -i localhost:3000/cash-in \
  -H "Idempotency-Key: $(uuidgen | tr A-Z a-z)" \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"usr_abc123","amount":100.00,"currency":"PEN","payment_method":"card_ok"}'
# 200 {"operation_id":"op_...","status":"completed","amount":100,"new_balance":350}
```

`payment_method` elige el escenario del proveedor falso: `card_ok`, `card_declined`, `card_timeout` (cobra y no responde a tiempo) y `card_flaky` (falla la primera vez por referencia).

| Comando | Qué hace |
|---|---|
| `bun run test:unit` | Tests unitarios, sin dependencias. |
| `bun run test:int` | Integración contra Postgres (`cashin_test`) y Redis reales. |
| `docker compose --profile e2e up -d --build && bun run test:e2e` | E2E contra `app1` y `app2` detrás de nginx en `localhost:8080`, con `mock-psp` y la base `cashin_e2e`. |
| `bun run typecheck` | `tsc --noEmit` en modo estricto. |
| `bun run infra:check` | `terraform fmt -check`, `init -backend=false` y `validate`. |

Para bajar solo el perfil e2e: `docker compose --profile e2e stop app1 app2 nginx mock-psp migrate`.

## Tests

| Nivel | Ubicación | Cantidad | Qué prueba |
|---|---|---|---|
| Unitario | [tests/unit/](tests/unit/) | 325 | Máquina de estados, huella, firma, retry, errores, schemas, servicio de cash-in con dobles, webhook con tabla de decisión, reconciliador, proveedores. |
| Integración | [tests/integration/](tests/integration/) | 67 | Postgres y Redis reales, varias apps con clientes separados como pods. |
| E2E | [tests/e2e/](tests/e2e/) | 6 | HTTP real contra 2 réplicas detrás de nginx y `mock-psp`. |

Escenarios del challenge y dónde se prueban:

| Escenario | Test |
|---|---|
| Doble click y pods concurrentes | 20 requests con la misma key en 3 pods: 1 operación, 1 cobro, 1 asiento ([cash-in.int.test.ts](tests/integration/features/cash-in/cash-in.int.test.ts) #6). Misma key en `app1` y `app2` por HTTP real (e2e #1). |
| Retry de la app | Replay con `Idempotent-Replayed: true` en éxito, rechazo y timeout (#2, #9, #11). |
| Timeout del proveedor | `202 unknown`, luego se completa por webhook o reconciliador (#10, e2e #4). |
| Webhook duplicado | Mismo evento en dos pods con `Promise.all` ([webhooks.int.test.ts](tests/integration/features/webhooks/webhooks.int.test.ts) #2, e2e #6). |
| Webhook fuera de orden | `failed` tras `COMPLETED` y `succeeded` tras `FAILED` (#3, #4). |
| Webhook antes de la respuesta | Proveedor bloqueado en `app1` y webhook por `app2` (#5). |
| Fallo temporal de DB | El primer intento responde 5xx y no deja el evento; el reintento lo procesa (#8). `withDbRetry` contra errores reales del adapter. |
| Reinicio durante la operación | `PENDING` atascada cobrada una vez por el reconciliador ([reconciliation.int.test.ts](tests/integration/features/reconciliation/reconciliation.int.test.ts) #8). |
| Race condition sobre el saldo | 50 abonos concurrentes desde 3 clientes: suma exacta en `Decimal` ([wallet.service.int.test.ts](tests/integration/features/wallet/wallet.service.int.test.ts)). 60 keys en 3 pods por HTTP (#7). |
| Redis caído | 20 requests concurrentes con la misma key y Redis inalcanzable: 1 operación (#13). |

Varias garantías se verificaron con pruebas de mutación, rompiendo a propósito el código para confirmar que el test falla:
- Cambiar `increment` por leer y escribir el saldo rompe el test de 50 abonos.
- Reintentar timeouts o marcar `FAILED` sin certeza rompe los tests del servicio.
- Quitar las dos defensas de la DB solo se detecta con Redis caído, lo que prueba que Redis optimiza y PostgreSQL garantiza ([ai-log #22](docs/ai-log.md)).

## Defensa técnica

### El proveedor cobra S/100, hay timeout, el cliente reintenta. ¿Cómo evitas cobrar dos veces?

| Paso | Dónde |
|---|---|
| 1. La operación se persiste `PENDING` con su `operation_id` antes de llamar al proveedor, y pasa a `PROCESSING` por CAS. | `cashIn` en [cash-in.service.ts](src/features/cash-in/cash-in.service.ts), `create` y `transition` en [cash-in.repository.ts](src/features/cash-in/cash-in.repository.ts) |
| 2. El cobro se envía con `reference = operation_id`, la idempotency key del proveedor. Los reintentos técnicos usan la misma. | `charge` en [cash-in.service.ts](src/features/cash-in/cash-in.service.ts) |
| 3. El timeout deja `UNKNOWN` y responde `202`. No se cobra de nuevo en línea. | Mismo archivo; `ProviderTimeoutError` en [errors.ts](src/infra/payment-provider/errors.ts) |
| 4. El retry del cliente con la misma key encuentra la operación (o choca con `P2002`) y devuelve su estado. | `findByKey` y `replayOf` |
| 5. La operación se resuelve sola: con el webhook `charge.succeeded` o con el reconciliador vía `getCharge(reference)`. | [webhooks.service.ts](src/features/webhooks/webhooks.service.ts), [reconciliation.service.ts](src/features/reconciliation/reconciliation.service.ts) |
| 6. Si hay que reenviar el cobro, va con la misma referencia, y el proveedor devuelve el cargo existente. | `FakePaymentProvider` y `mock-psp` lo modelan así |
| 7. Acreditar dos veces es imposible: CAS a `COMPLETED` + `LedgerEntry.operationId @unique` en una transacción. | `applyCredit` en [wallet.service.ts](src/features/wallet/wallet.service.ts) |

La única forma de cobrar dos veces sería generar una referencia nueva para la misma intención, y ningún camino del código lo hace.

### Escala a 1M operaciones por día

Son unas 12 por segundo en promedio. El diseño actual no tiene estado en memoria y escala horizontalmente con más pods. No se hicieron pruebas de carga, así que no hay cifras medidas. Cambios que harían falta a más escala, de [design §15](specs/cash-in/design.md#15-escala-a-1m-operaciones-por-día), **ninguno implementado**:
- Particionar `CashInOperation` y `WebhookEvent` por fecha y archivar.
- Sacar el reconciliador a un worker dedicado con cola.
- Encolar webhooks (por ejemplo SQS) y procesarlos de forma asíncrona.
- Outbox para eventos de dominio.
- PgBouncer y réplicas de lectura.
- Expirar keys de idempotencia viejas.

### Redis vs base de datos para idempotencia

Redis da latencia sub-milisegundo, pero su lock tiene TTL y puede perderse en un failover. No puede ser atómico con el abono. PostgreSQL da una restricción única transaccional, en la misma base que guarda el dinero. Por eso aquí Redis es solo una barrera que evita trabajo duplicado, y la garantía está en PostgreSQL. Con Redis caído todo sigue siendo correcto, y el test #13 lo prueba. Detalle en [design §16](specs/cash-in/design.md#16-redis-vs-base-de-datos-para-idempotencia).

## Pilotaje y orquestación de agentes IA

### Método

1. **Specs primero.** [requirements.md](specs/cash-in/requirements.md) (EARS), [design.md](specs/cash-in/design.md) y [tasks.md](specs/cash-in/tasks.md). El usuario los revisó y aprobó antes de escribir código.
2. **Un plan por tarea** en [specs/cash-in/plans/](specs/cash-in/plans/), con archivos, pasos, criterios de aceptación y una sección "Trampas conocidas" con los errores típicos de un agente en esa tarea. Ejemplos: `$queryRaw` en el health check, `Float` para montos, `DEL` directo para liberar el lock.
3. **[AGENTS.md](AGENTS.md) como única fuente de reglas**, importada por `CLAUDE.md` y `GEMINI.md`. Contiene las reglas no negociables de idempotencia, acceso a datos, dinero, errores y tests.

### Orquestación

El detalle completo, con el prompt real de lanzamiento, está en [docs/orchestration.md](docs/orchestration.md).

| Rol | Quién |
|---|---|
| Specs, planes, revisión, commits y merges | Claude Code |
| Ejecución de planes | Gemini (T2.1 a T2.4, lanzado a mano), Antigravity con `agy -p` lanzado desde Claude Code (desde T2.5) |
| Tareas críticas (`applyCredit`, servicio, webhook, reconciliador) | Claude Code y dos subagentes de Claude Code |
| Decisiones, aprobaciones y permisos | El usuario |

- Un worktree de git y una rama por tarea, en tandas paralelas según el campo "Paralelo con" de cada plan. La tanda más grande fue de 8 agentes de Antigravity.
- El ejecutor no commitea, no edita `tasks.md` ni `ai-log.md`, y se detiene ante una contradicción.
- El revisor verifica fuera de los tests del agente y hace un squash merge con un commit por tarea.
- Todos los agentes compartían Postgres y Redis, así que cada test usa datos únicos y nadie limpia tablas.

### Qué se corrigió

[docs/ai-log.md](docs/ai-log.md) registra cada corrección con quién la detectó. Algunas:

| # | Qué propuso el agente | Quién lo detectó | Resultado |
|---|---|---|---|
| [3](docs/ai-log.md) | `SQL` crudo para el CAS y el saldo | El usuario | Solo cliente Prisma: `updateMany`, `increment`, `P2002`. |
| [6](docs/ai-log.md) | Proveedor falso en memoria de cada pod | Claude Code | `mock-psp` como contenedor, o el e2e multi-pod no prueba nada. |
| [17](docs/ai-log.md) | Health check probado solo con dobles | Claude Code | Postgres inalcanzable colgaba 75 s; timeout de conexión de 2 s. |
| [19](docs/ai-log.md) | `withDbRetry` con errores fabricados | Claude Code | Una caída real no se reintentaba: respondía 500 en vez de 503. |
| [20](docs/ai-log.md) | Plan con un test de concurrencia imposible | Antigravity | El agente corrigió al planificador. |
| [21](docs/ai-log.md) | Claim del lease sin tope de intentos | Subagente de Claude Code | Un pod reclamaba operaciones agotadas por otro. Spec corregido. |
| [23](docs/ai-log.md) | Mock con el webhook antes del timeout | Antigravity | El e2e de timeout probaba otro escenario. |

## Decisiones y límites conocidos

- **Terraform no está desplegado.** Solo pasa `fmt` y `validate`. El secreto `webhook_secret` se crea sin valor y hay que cargarlo fuera de Terraform antes del primer deploy.
- **Sin pruebas de carga.** No hay cifras de rendimiento.
- **El proveedor real no existe.** `FakePaymentProvider` y `mock-psp` modelan la idempotencia por referencia que se espera de una pasarela real.
- **Respuesta perdida tras el `create`.** Si el `create` hace commit pero la respuesta se pierde por la red, `withDbRetry` reintenta, recibe `P2002` y responde como replay de una operación `PENDING` sin cobrar. No hay doble cobro; la cobra el reconciliador.
- **Postgres que no responde.** El `503` tarda unos 6 s: 3 intentos con un timeout de conexión de 2 s cada uno.
- **Claim del reconciliador.** No revalida la antigüedad de la operación. Tras liberar un lease, otro pod puede reintentar en el mismo ciclo. Gasta un intento extra, siempre con la misma referencia.
- **Diferencia con el spec.** [design §1](specs/cash-in/design.md#1-arquitectura) menciona "utilidades de dinero" en `src/shared/`, pero no existe un módulo propio: los montos se manejan directamente con `Prisma.Decimal`.
- **Solo PEN**, y el monto máximo por operación es `CASH_IN_MAX_AMOUNT` (10000 por defecto).

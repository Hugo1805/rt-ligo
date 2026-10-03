# Wallet Cash-In · Challenge Backend Senior Ligo

Servicio de recarga de saldo vía pasarela de pagos externa, con idempotencia real entre múltiples pods.

> En construcción con spec-driven development. Este README se completa en la tarea 9.1.

## Dónde mirar

| Documento | Contenido |
|---|---|
| [specs/cash-in/requirements.md](specs/cash-in/requirements.md) | Qué debe cumplir el sistema. |
| [specs/cash-in/design.md](specs/cash-in/design.md) | Arquitectura, idempotencia, concurrencia, webhooks, errores y modelo de datos. |
| [specs/cash-in/tasks.md](specs/cash-in/tasks.md) | Tareas y avance. |
| [specs/cash-in/plans/](specs/cash-in/plans/) | Plan ejecutable de cada tarea. |
| [AGENTS.md](AGENTS.md) | Reglas para los agentes de IA. |
| [docs/ai-log.md](docs/ai-log.md) | Qué se le pidió al agente y qué se corrigió. |

## Stack

Bun, Hono, zod, Prisma, PostgreSQL, Redis, `bun:test`, Docker Compose y Terraform sobre AWS.

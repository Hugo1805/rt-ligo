# Bitácora de pilotaje del agente IA

> Registro de lo que se le pidió al agente (Claude Code) y de lo que hubo que corregir o rediseñar.
> Solo se anotan hechos ocurridos. Cada entrada indica quién detectó el problema.

## Cómo se trabajó

1. Se le dio al agente el PDF del challenge y se le pidió un plan, sin escribir código.
2. Se fijó la metodología SDD: primero `requirements.md`, `design.md` y `tasks.md`, luego código.
3. El plan se rechazó y corrigió varias veces antes de aprobarlo. Esas correcciones están abajo.
4. La implementación sigue `tasks.md` tarea por tarea, con tests en cada fase.

## Specs y prompts dados al agente

| Momento | Instrucción |
|---|---|
| Inicio | "Usaremos SDD para crear primero los specs. Stack de siempre: Bun, Hono, Prisma, PostgreSQL y Redis, Docker Compose para la DB y Redis en local, Terraform para la arquitectura dirigida a AWS." |
| Inicio | Idempotencia con PostgreSQL + Redis. |

## Correcciones durante el plan

### 1. Runner de tests

- **Propuesta del agente:** Jest con la API de Jest, ejecutado con `bun test` o `ts-jest`.
- **Corrección:** "Usamos los test de Bun, no Jest."
- **Detectado por:** el usuario.
- **Resultado:** todo el testing usa `bun:test`.

### 2. Ambigüedad del "token" del lock

- **Propuesta del agente:** "liberación con script Lua que compara el token".
- **Corrección:** el usuario preguntó qué token era, porque la operación es fiat y no cripto.
- **Detectado por:** el usuario.
- **Resultado:** el valor del lock se renombró `ownerId` y se explicó que es un UUID del dueño del lock, sin relación con dinero.

### 3. SQL crudo

- **Propuesta del agente:** CAS con `UPDATE ... WHERE status IN (...)` y reconciliador con `SELECT ... FOR UPDATE SKIP LOCKED`.
- **Corrección:** "Recuerda que siempre usaremos código Prisma."
- **Detectado por:** el usuario.
- **Resultado:** CAS con `updateMany` y chequeo de `count`. Incremento con `{ increment }`. El `SKIP LOCKED` se reemplazó por un lease con columnas `leaseOwner` y `leaseUntil` reclamado vía `updateMany`.

### 4. Body de error indefinido

- **Propuesta del agente:** solo una tabla de códigos HTTP.
- **Corrección:** "Definir el body del error es importante."
- **Detectado por:** el usuario.
- **Resultado:** formato único RFC 9457 `application/problem+json` con `code` estable, `retryable` y `request_id`, más un catálogo de códigos.

### 5. Niveles de test

- **Propuesta del agente:** principalmente tests de integración.
- **Corrección:** "Que sean unitarios, integración y e2e."
- **Detectado por:** el usuario.
- **Resultado:** tres carpetas y tres comandos. Los e2e corren contra dos réplicas detrás de nginx.

## Correcciones durante los specs

### 6. Proveedor falso en memoria rompe el e2e multi-pod

- **Problema:** con un proveedor falso en memoria dentro de cada pod, dos réplicas no comparten sus cobros. La idempotencia por referencia no se podría probar entre pods.
- **Detectado por:** el agente, al escribir `design.md`.
- **Resultado:** el e2e usa un contenedor `mock-psp` aparte y un adaptador `HttpPaymentProvider`.

### 7. Dedupe de webhook fuera de la transacción

- **Problema:** si el evento se marca como visto antes de aplicar su efecto, un fallo intermedio hace que el reintento del proveedor se descarte como duplicado y el abono se pierda.
- **Detectado por:** el agente, al escribir `design.md`.
- **Resultado:** el insert del evento y su efecto van en la misma transacción.

### 8. Validación del body sin herramienta definida

- **Propuesta del agente:** R1 listaba las reglas del body, pero no decía cómo se validaba. El diseño solo mencionaba zod para la configuración.
- **Corrección:** "En el R1 no estamos validando el body, ¿no? Usamos zod para eso."
- **Detectado por:** el usuario, al revisar los specs.
- **Resultado:** schemas zod para el header, el body de `POST /cash-in` y el payload del webhook, con `@hono/zod-validator`. El body usa `.strict()`. La validación ocurre antes de cualquier efecto y sus fallos salen como `VALIDATION_ERROR` con la lista de campos.

### 9. Organización por capas en vez de por feature

- **Propuesta del agente:** carpetas `modules/<x>/{routes,service,repository}.ts`, con `jobs/` y `infra/` separados.
- **Corrección:** "Recuerda que usaremos Feature-First para el patrón de organización de carpetas."
- **Detectado por:** el usuario.
- **Resultado:** `src/features/{cash-in,webhooks,wallet,reconciliation,health}` con nombres `<feature>.<rol>.ts` y tests unitarios e de integración junto al código. Reglas de dependencia entre features en `AGENTS.md`.

### 10. Git y repositorio ausentes en las tareas

- **Propuesta del agente:** `tasks.md` empezaba directo en el código, sin inicializar git ni crear el repositorio.
- **Corrección:** "Inicializar el git, que no lo veo en los tasks, y usar el CLI de gh para crear el repositorio en público."
- **Detectado por:** el usuario.
- **Resultado:** tareas 1.5 y 1.6. Convención de un commit por tarea con Conventional Commits y el id de la tarea.

### 11. Trabajo con más de un agente

- **Pedido del usuario:** una carpeta con el plan de cada tarea para ejecutarlas con Gemini, y un `AGENTS.md` para que todos los agentes sigan las mismas reglas.
- **Resultado:** `specs/cash-in/plans/` con plantilla, flujo y prompt para Gemini. Cada plan tiene una sección "Trampas conocidas" con los errores típicos del agente, que el revisor busca en el diff. `AGENTS.md` es la fuente única de reglas, y `CLAUDE.md` y `GEMINI.md` solo lo importan.

### 12. API de zod desactualizada en el diseño

- **Problema:** el snippet de `design.md` usaba `required_error`, que es API de zod 3. La versión actual es zod 4.
- **Detectado por:** el agente, al escribir el plan de T2.1.
- **Resultado:** snippet migrado a `z.uuid({ error })` de zod 4.

## Correcciones durante la implementación

### 13. T2.1: driver adapter de Prisma 7 omitido

- **Propuesta del agente:** Gemini instaló Prisma 7.10 sin `@prisma/adapter-pg`, aunque el plan pedía seguir la guía de la versión instalada. Además, `test:int` y `test:e2e` fallaban con código 1 mientras no hubiera tests, y el ejecutor hizo el commit él mismo.
- **Detectado por:** Claude Code, al revisar la rama `chore/T2.1-project-setup`.
- **Resultado:** se agregó `@prisma/adapter-pg` y `--pass-with-no-tests`. El plan de T2.3 suma las trampas de Prisma 7: generador `prisma-client` con `output`, URL en `prisma.config.ts`, cliente construido con el adapter y seed que ya no corre solo.

### 14. T2.2: el ejecutor commitea porque las reglas se contradecían

- **Propuesta del agente:** Gemini entregó T2.2 correcta, pero de nuevo hizo el commit y marcó el plan como `done` sin pasar por revisión, igual que en T2.1.
- **Detectado por:** Claude Code, al revisar la rama `chore/T2.2-docker-compose`. Al buscar la causa, encontró que `AGENTS.md` ordenaba "Haz un commit por tarea" y marcar `done`, mientras el README de plans decía "No hagas commit". El agente seguía la regla de mayor jerarquía.
- **Resultado:** `AGENTS.md` ahora dice que el ejecutor deja el plan en `review` sin commitear, y que quien revisa marca `tasks.md`, pasa a `done` y commitea. Lección: si el agente repite un error, revisar primero las instrucciones antes de culpar al agente.

### 15. T2.3: fallback silencioso a la base de dev

- **Propuesta del agente:** Gemini escribió el schema exacto y la config de Prisma 7 correcta, gracias a las trampas del plan. Pero en `prisma.config.ts` y `seed.ts` puso `process.env.DATABASE_URL ?? "postgresql://...localhost:5432/cashin"`. No había `.env`, y la verificación pasó solo por ese fallback.
- **Detectado por:** Claude Code, al notar que la verificación pasaba sin `.env`.
- **Resultado:** se cambió a `env("DATABASE_URL")`, que falla si falta la variable. Un default en la URL de la base convierte un error de configuración en escrituras sobre la base equivocada, por ejemplo tests de integración limpiando la base de dev.

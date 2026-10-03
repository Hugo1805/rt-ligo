# Bitácora de pilotaje del agente IA

> Registro de lo que se le pidió a los agentes (Claude Code, Gemini y Antigravity) y de lo que hubo que corregir o rediseñar.
> Solo se anotan hechos ocurridos. Cada entrada indica quién detectó el problema.

## Cómo se trabajó

1. Se le dio al agente el PDF del challenge y se le pidió un plan, sin escribir código.
2. Se fijó la metodología SDD: primero `requirements.md`, `design.md` y `tasks.md`, luego código.
3. El plan se rechazó y corrigió varias veces antes de aprobarlo. Esas correcciones están abajo.
4. La implementación sigue `tasks.md` tarea por tarea, con un plan por tarea en `specs/cash-in/plans/`.
5. Claude Code planifica, revisa, corrige y fusiona. Gemini (T2.1 a T2.4) y Antigravity con `agy -p` (desde T2.5) ejecutan los planes, desde la fase 3 en paralelo, un worktree por tarea. El detalle está en [orchestration.md](orchestration.md).

## Specs y prompts dados al agente

| Momento | Instrucción |
|---|---|
| Inicio | "Usaremos SDD para crear primero los specs. Stack de siempre: Bun, Hono, Prisma, PostgreSQL y Redis, Docker Compose para la DB y Redis en local, Terraform para la arquitectura dirigida a AWS." |
| Inicio | Idempotencia con PostgreSQL + Redis. |
| Specs | Las instrucciones citadas en las entradas 1 a 5 y 8 a 11. |
| Ejecución con Gemini, T2.1 a T2.4 | El prompt de [plans/README.md](../specs/cash-in/plans/README.md#cómo-pedirle-una-tarea-a-gemini): "Lee AGENTS.md y specs/cash-in/plans/fase-2/T2.1-project-setup.md. Ejecuta solo ese plan. No toques archivos fuera de la sección "Archivos". Cuando termines, corre los comandos de "Verificación" y muéstrame la salida. Si algo del plan contradice los specs o no se puede cumplir, detente y explícalo antes de improvisar. No hagas commit." |
| Ejecución con Antigravity, T2.5 a T7.3 | El prompt base de [orchestration.md](orchestration.md#lanzamiento-de-un-ejecutor), lanzado con `agy -p` desde cada worktree, más restricciones por tarea (nombres reales de lo existente, recursos compartidos, Terraform sin `apply`, no debilitar tests). |
| Ejecución con subagentes de Claude Code, T5.1 y T6.1 | El mismo protocolo, con rutas absolutas al worktree y un reporte final de desvíos y fallas del plan. |

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

### 16. T2.4: refinamiento de zod 4 que se salta y reintentos en cero

- **Propuesta del agente:** Gemini validó la config con un `.refine` a nivel de objeto para exigir `PROVIDER_BASE_URL` en modo `http`, y `PROVIDER_MAX_RETRIES` con `.positive()`. Sus tests pasaban porque probaban cada error por separado.
- **Detectado por:** Claude Code, probando combinaciones de errores fuera de los tests del agente.
- **Resultado:** en zod 4 el refinamiento no corre si otro campo falla, así que el error no listaba todas las variables. Se agregó `when: () => true`. `PROVIDER_MAX_RETRIES` pasó a `.nonnegative()` para admitir `0`. Se sumaron dos tests.

### 17. T2.6: base de datos inalcanzable cuelga el request 75 segundos

- **Propuesta del agente:** Antigravity, lanzado con `agy -p` desde Claude Code, hizo un health check correcto y sin `$queryRaw`, con Redis configurado para fallar rápido. Sus tests usaban dobles que fallan al instante y un Postgres real sano, y reportó el `grep` de `queryRaw` como limpio cuando en realidad encuentra coincidencias en el cliente generado.
- **Detectado por:** Claude Code, probando `/health` contra un puerto cerrado y contra una IP que no responde, para Postgres y para Redis.
- **Resultado:** el puerto cerrado fallaba rápido, pero con la IP que no responde el request tardaba 75 s, porque `pg` no tiene timeout de conexión. Se agregó `connectionTimeoutMillis` en `createPrismaClient` y ahora responde 503 en 2 s. También se agregó `await server.stop()` en el apagado y se corrigió el `grep` del plan. Lección: un doble que falla al instante no prueba el caso de red que no responde, que es el más común en producción.

### 18. Fase 3 en paralelo: ocho agentes en worktrees

- **Propuesta del agente:** Claude Code lanzó ocho Antigravity con `agy -p` a la vez (T3.1 a T3.5, T4.1, T4.2 y T8.1), cada uno en su propio worktree y rama, con prohibición de commitear o editar `tasks.md` y `ai-log.md`. La primera prueba con `--add-dir` dejaba la terminal del agente en el repo principal, así que se descartó y cada agente se lanzó desde su worktree.
- **Detectado por:** Claude Code, en la revisión de cada rama.
- **Resultado:** cinco ramas sin correcciones (T3.2, T3.3, T3.4, T3.5 y T4.2), verificadas por fuera: vectores HMAC y SHA-256 recalculados con `openssl` y `shasum`, y el lock probado contra una IP que no responde. Tres con correcciones:
  - T3.1: la tabla de transiciones exportada era `readonly` solo en tipos; se congeló con `Object.freeze`.
  - T4.1: errores con un constructor ambiguo para `cause`, y el fake devolvía el objeto guardado, mutable desde afuera.
  - T8.1: la clave de RDS con `#`, `?` y `%` se interpolaba sin codificar en `DATABASE_URL`, que habría impedido conectar en el primer deploy.

### 19. T4.4: una caída real de Postgres no se reintentaba

- **Propuesta del agente:** Antigravity implementó `withDbRetry` con los 6 códigos de design §7 y tests con errores de Prisma construidos a mano. Marcó todos los criterios, pero omitió la prueba manual con Postgres caído que el plan pedía en sus trampas.
- **Detectado por:** Claude Code, probando con el adapter real contra un puerto cerrado, una IP que no responde y una clave incorrecta.
- **Resultado:** con `@prisma/adapter-pg` el puerto cerrado llega como `code: "ECONNREFUSED"` y el timeout como un `Error` plano del pool de `pg`. Ninguno era transitorio, así que una caída de DB respondía `500` en vez de `503` con `Retry-After`. Se documentó en design §7, se agregaron los códigos de red y los mensajes del pool, y se sumaron tests. Lección: un test con errores fabricados prueba la forma que uno supone, no la que llega en una caída real.

### 20. T4.3: el agente detecta un error en el plan

- **Propuesta del plan:** el plan de T4.3, escrito por Claude Code antes del código, pedía un test donde `PROCESSING→FAILED` y `PROCESSING→UNKNOWN` concurrentes daban un solo ganador.
- **Detectado por:** Antigravity. Notó que `UNKNOWN→FAILED` es válida en R7.2, así que si `UNKNOWN` gana primero las dos transiciones devuelven `true`. Se detuvo y propuso un CAS concurrente al mismo destino, en vez de debilitar la aserción.
- **Resultado:** Claude Code confirmó la contradicción y reemplazó el test por 10 CAS concurrentes `PROCESSING→UNKNOWN` desde 3 clientes y un test de orden entre `FAILED` y `UNKNOWN`. La regla de AGENTS.md de detenerse ante una contradicción funcionó en la dirección inversa: el agente corrigió al planificador.

### 21. T4.5, T4.6, T5.1 y T6.1: subagentes de Claude Code y un hueco del spec

- **Propuesta:** las cuatro tareas que los planes asignan a Claude Code (el núcleo de idempotencia) se hicieron en paralelo: T4.5 y T4.6 por la sesión principal, T5.1 y T6.1 por dos subagentes en worktrees propios, con el mismo protocolo que Antigravity (sin commit, reporte de desvíos).
- **Detectado por:** el subagente de T6.1, al correr dos reconciliadores reales sobre clientes Prisma separados. El claim del lease de design §7 no filtraba `reconcileAttempts`: un pod con una lista vieja reclamaba una operación ya agotada por otro, contra R10.6.
- **Resultado:** filtro agregado al `claimLease` y a design §7. En T4.5, Claude Code se desvió del plan para releer la operación tras un CAS perdido, porque el `from` leído antes del CAS era viejo. T4.5 y T4.6 se verificaron con pruebas de mutación: cambiar `increment` por leer y escribir rompe el test de 50 abonos concurrentes, y reintentar timeouts o marcar `FAILED` sin certeza rompe los tests del servicio.

### 22. T4.8: mutaciones para probar cada capa de idempotencia

- **Propuesta del agente:** Antigravity escribió 18 escenarios HTTP de integración con 3 pods simulados, incluidos 20 requests concurrentes con la misma key, 60 keys distintas del mismo usuario y Redis caído. Todos en verde.
- **Detectado por:** Claude Code, que no aceptó el verde sin probar que los tests detectan el bug que dicen cubrir. Una primera mutación (tratar el duplicado del `create` como propio) sobrevivió.
- **Resultado:** no era un test débil sino defensa en profundidad: el CAS `PENDING→PROCESSING` frenaba el segundo cobro. Al quitar también ese CAS, con Redis arriba los tests seguían pasando por el lock, y con Redis caído el escenario 13 detectó el segundo `charge`. Queda demostrado con evidencia que Redis optimiza y PostgreSQL garantiza.

### 23. T7.3: el e2e de timeout probaba otro escenario

- **Propuesta del agente:** Antigravity escribió 6 tests e2e contra nginx y dos réplicas. El de `card_timeout` esperaba `202 unknown` y recibía `200 completed`.
- **Detectado por:** Antigravity, que en vez de aceptar el `200` rastreó la causa: el mock enviaba el webhook a los 1000 ms, antes del timeout de 3000 ms de la app, así que el webhook completaba la operación antes de la respuesta. Se detuvo porque el arreglo estaba en `docker-compose.yml`, fuera de su tabla de archivos.
- **Resultado:** Claude Code fijó `MOCK_PSP_WEBHOOK_DELAY_MS: 6000` en `mock-psp` (introducido sin ese valor en T7.2). 6 de 6 en verde dos veces. La configuración vieja no rompía la app: ejercitaba R9.8 de punta a punta, y el test de timeout ahora ejercita el camino `UNKNOWN`.

### 24. T3.6: claves sobrantes reportadas sin nombre de campo

- **Propuesta del agente:** Antigravity mapeó cada issue de zod a `{ field: path.join("."), message }`.
- **Detectado por:** Claude Code, probando el schema con un campo extra (`ammount`).
- **Resultado:** con `.strict()`, zod 4 reporta todas las claves sobrantes en un solo issue con `path: []`, y el cliente recibía `field: ""`. `issuesToFieldErrors` ahora emite un error por clave con su nombre. Con test.

### 25. T4.7: hueco del plan y una fusión automática que rompió `server.ts`

- **Propuesta del agente:** Antigravity sumó `paymentProvider` y `lock` a `AppDeps`. Se detuvo antes de tocar `health.int.test.ts`, que llamaba a `createApp` sin esas dependencias y no estaba en su tabla de archivos.
- **Detectado por:** Antigravity el hueco del plan; Claude Code la fusión. `git merge` combinó el `server.ts` del agente (que lanzaba error con `PROVIDER_MODE=http` porque partió de antes de T7.1) con el de `main`, y dejó imports y `paymentProvider` duplicados sin marcar conflicto.
- **Resultado:** el revisor completó `health.int.test.ts` y reescribió `server.ts` con el proveedor de T7.1, el lock y el reconciliador de T6.1. Luego probó `POST /cash-in` contra el servidor real.

### 26. Tests fuera de `src/`

- **Propuesta del agente:** tests unitarios y de integración junto al código, como fijaba `AGENTS.md` desde la entrada 9.
- **Corrección:** "cree 2 carpetas en test unit e integration porfa pasa todos los test a esa capetas ya que contaminan el codigo".
- **Detectado por:** el usuario.
- **Resultado:** 23 archivos movidos a `tests/unit/` y `tests/integration/`, replicando la ruta de `src/`, con los imports recalculados. Scripts por carpeta, `AGENTS.md` y planes pendientes actualizados. Las ramas en curso se movieron al fusionarlas.

### 27. T9.1: los scripts de Prisma fallaban en un clon limpio

- **Propuesta:** desde T2.1, `db:generate`, `db:migrate` y `db:deploy` llamaban a `prisma` sin `--bun`.
- **Detectado por:** Claude Code, al correr los comandos del README desde un clon limpio, como pedía el plan de T9.1.
- **Resultado:** con Node, el CLI no carga `.env` y fallaba con `Cannot resolve environment variable: DATABASE_URL`. En el repo de trabajo nunca se vio porque siempre se usó `bunx --bun prisma` a mano. Los scripts pasaron a `bunx --bun prisma`, en un commit aparte.

## Lecciones

1. **Un test con dobles prueba la forma que uno supone, no la que llega.** El health check colgaba 75 s con un host que no responde y una caída real de Postgres no se reintentaba, aunque los tests de ambos estaban en verde (#17, #19). Probar contra la dependencia real rota encontró los dos.
2. **Si el agente repite un error, revisar primero las instrucciones.** Gemini commiteaba porque `AGENTS.md` se lo ordenaba (#14). Un fallback en la config ocultaba que faltaba `.env` (#15), y los scripts solo funcionaban por un hábito del revisor (#27).
3. **La regla de detenerse ante una contradicción vale en las dos direcciones.** Antigravity y un subagente encontraron errores del plan y del spec en vez de forzar el código (#20, #21, #23, #25).
4. **Un verde no basta: hay que romper a propósito lo que el test dice cubrir.** Las mutaciones mostraron que Redis sostiene la idempotencia solo mientras está arriba, y que la garantía real es PostgreSQL (#22).
5. **El paralelismo exige reglas sobre lo compartido.** Ocho agentes sobre la misma base funcionaron porque nadie limpiaba tablas, los ids eran aleatorios y solo el revisor editaba `tasks.md` y el ai-log. Aun así, una fusión sin conflicto marcado rompió `server.ts` (#18, #25).
6. **Las decisiones de estructura las toma el usuario.** Prisma en vez de SQL, Feature-First, bun:test y tests fuera de `src/` fueron correcciones del usuario (#1, #3, #9, #26).

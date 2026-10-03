# Orquestación de agentes

Cómo se repartió el trabajo entre Claude Code, Antigravity (`agy`), Gemini y subagentes de Claude Code. Las correcciones concretas están en [ai-log.md](ai-log.md).

## Roles

| Rol | Quién | Qué hace |
|---|---|---|
| Planificador y revisor | Claude Code, sesión principal | Escribe specs y planes, lanza ejecutores, revisa cada rama, corrige, hace el commit y la fusiona a `main`. |
| Ejecutor | Gemini (T2.1 a T2.4), Antigravity con `agy -p` (desde T2.5) | Implementa un plan en su rama. No commitea. |
| Ejecutor de tareas críticas | Claude Code: sesión principal (T4.5, T4.6) y subagentes (T5.1, T6.1) | Las tareas que los planes asignan a Claude Code: `applyCredit`, servicio de cash-in, webhook y reconciliador. |
| Decisor | El usuario | Aprueba specs, decide stack y estructura, autoriza merges, permisos y borrados. |

## Evolución

1. **T2.1 a T2.4:** el usuario lanzaba Gemini a mano con el plan de la tarea. Claude Code revisaba la rama. En T2.1 y T2.2 Gemini commiteó solo, porque `AGENTS.md` decía "Haz un commit por tarea" y contradecía al README de planes ([ai-log #14](ai-log.md)). Se corrigió la regla.
2. **T2.5 y T2.6:** Claude Code lanzó Antigravity con `agy -p` desde su terminal, una tarea por vez. Requirió que el usuario agregara la regla `Bash(agy -p:*)` en `~/.claude/settings.json`: un permiso dado en el chat no alcanzaba.
3. **Desde la fase 3:** tandas en paralelo, un worktree de git y una rama por tarea, según la fila "Paralelo con" de cada plan. Primera tanda de 8 agentes (T3.1 a T3.5, T4.1, T4.2, T8.1), luego 4, luego tandas mixtas de Antigravity y subagentes de Claude Code.

## Lanzamiento de un ejecutor

Cada tarea en paralelo tiene su worktree, preparado por el revisor:

```bash
git worktree add ../rt-ligo-wt/T4.3 -b feat/T4.3-operation-repository main
cp .env .env.test ../rt-ligo-wt/T4.3/
cd ../rt-ligo-wt/T4.3 && bun install --frozen-lockfile && bunx --bun prisma generate
```

Antigravity se lanza desde el worktree, en segundo plano:

```bash
cd ../rt-ligo-wt/T4.3 && agy -p "<prompt>" --sandbox --dangerously-skip-permissions
```

- `-p` corre sin interacción. En ese modo agy deniega toda herramienta que necesite aprobación, por eso `--dangerously-skip-permissions`, acotado con `--sandbox`.
- `--add-dir <worktree>` no sirve: agrega el directorio pero la terminal del agente sigue en el repo principal, y con varios agentes alguno podía escribir en `main`. Se descartó tras probarlo.

El prompt base, usado en todas las tareas con los nombres de la tarea y su plan:

```text
Ejecuta la tarea T3.1 de este repo. Trabaja solo dentro del directorio actual, que es un worktree
de git en la rama feat/T3.1-state-machine. Lee AGENTS.md y luego
specs/cash-in/plans/fase-3/T3.1-state-machine.md, e implementa solo lo que dice el plan, respetando
'Restricciones' y 'Trampas conocidas'. Revisa la API real de las dependencias instaladas en
node_modules en vez de suponerla. Corre los comandos de la sección 'Verificación' del plan y
'bun run typecheck' hasta que pasen. Al terminar, marca en el plan los criterios de aceptación que
verificaste y deja su Estado en 'review'. NO hagas git commit, git push, ni cambies de rama.
NO edites specs/cash-in/tasks.md ni docs/ai-log.md. No toques archivos fuera de la tabla 'Archivos'
del plan salvo el propio plan; si el plan contradice el código real o los specs, detente y explícalo.
Termina con un resumen breve de los archivos creados y el resultado de cada comando.
```

Según la tarea se agregaban restricciones concretas:
- Nombres reales de lo que ya existía, para que no lo reescribiera: "Usa allowedSources de src/shared/operation-state-machine.ts y createPrismaClient de src/infra/prisma.ts tal como existen".
- Recursos compartidos: "otros agentes usan la misma base a la vez, así que usa datos únicos por test [...] y nunca hagas deleteMany sin filtro ni TRUNCATE"; "NUNCA corras 'docker compose down'".
- Terraform: "NUNCA corras terraform plan, apply ni destroy, ni uses credenciales de AWS".
- En tareas de tests: "si [...] un test revela un bug en src/, detente y explícalo en vez de debilitar el test".

Los subagentes de Claude Code recibieron el mismo protocolo, con rutas absolutas al worktree y un reporte final con desvíos y fallas del plan.

## Protocolo del ejecutor

- No commitea, no hace push, no cambia de rama.
- No edita `tasks.md` ni `ai-log.md`: son archivos que todas las ramas tocarían, y los edita solo el revisor.
- Deja el plan en `review` con sus criterios marcados.
- Ante una contradicción entre plan, specs y código, se detiene y la explica.

La regla de detenerse funcionó en los dos sentidos. En T4.3, T4.7 y T7.3 fue el ejecutor quien encontró el error, en el plan o en otra tarea, y paró en vez de improvisar ([ai-log #20](ai-log.md), [#23](ai-log.md)).

## Revisión e integración

Por cada rama terminada, el revisor:
1. Lee el diff contra los criterios y las "Trampas conocidas" del plan.
2. Verifica por fuera de los tests del agente: vectores HMAC y SHA-256 recalculados con `openssl` y `shasum`, Postgres y Redis apuntando a una IP que no responde, el servidor real con `curl`, y pruebas de mutación que rompen a propósito la garantía que un test dice cubrir.
3. Corrige, anota la revisión en el plan y, si hubo un error del agente, agrega la entrada al ai-log.
4. Hace commit en la rama, `git merge --squash` en `main`, marca la tarea en `tasks.md` y crea un commit por tarea con el formato `tipo(scope): descripción [T<id>]`.
5. Resuelve conflictos entre ramas paralelas. El caso repetido fue `src/server.ts`, que tocaron T4.7, T6.1 y T7.1. En T4.7 la fusión automática duplicó imports sin marcar conflicto, y solo se vio al revisar.
6. Corre la suite completa en `main`, hace push y borra el worktree.

## Recursos compartidos

Todos los ejecutores usaban el mismo Postgres y el mismo Redis de Docker Compose:
- Cada test crea sus propios datos con ids aleatorios. Nadie limpia tablas ni hace `FLUSHDB`.
- Las columnas `@unique` (`providerChargeId`, `providerEventId`) reciben valores aleatorios, porque los datos persisten entre corridas.
- El reconciliador busca candidatos en toda la tabla, así que sus tests envuelven el repositorio y filtran por los ids del propio test.
- El perfil `e2e` se baja nombrando sus servicios. `name: rt-ligo` en `docker-compose.yml` hace que todos los worktrees compartan el mismo proyecto Compose.

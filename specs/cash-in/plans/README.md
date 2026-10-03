# Plans por tarea

Cada tarea de [tasks.md](../tasks.md) tiene aquí un plan ejecutable por un agente: Gemini, Antigravity o Claude Code.
El plan baja el spec al nivel de archivos, pasos y criterios de aceptación, para que el agente no tenga que inventar decisiones.

## Flujo

```
1. Planificar   Se escribe T<id>-<slug>.md con la plantilla de abajo. Estado: todo.
2. Ejecutar     El agente ejecutor lee AGENTS.md y el plan, e implementa. Estado: in-progress.
3. Verificar    El agente corre los comandos de "Verificación". Todos en verde. Estado: review.
4. Revisar      Una persona u otro agente revisa el diff contra los criterios y las trampas conocidas.
5. Cerrar       Quien revisa marca la tarea en tasks.md, pasa el plan a done y hace el commit de la tarea.
```

Si la revisión encuentra un error del agente, se corrige y se anota en [docs/ai-log.md](../../../docs/ai-log.md) con quién lo detectó.

## Cómo pedirle una tarea a Gemini

Prompt para pegar en Gemini o Antigravity, cambiando el id:

```
Lee AGENTS.md y specs/cash-in/plans/T2.1-project-setup.md.
Ejecuta solo ese plan. No toques archivos fuera de la sección "Archivos".
Cuando termines, corre los comandos de "Verificación" y muéstrame la salida.
Si algo del plan contradice los specs o no se puede cumplir, detente y explícalo antes de improvisar.
No hagas commit.
```

El commit lo hace quien revisa, después de validar el diff.

## Nombres

`T<id>-<slug>.md`, con el id de `tasks.md` y un slug corto en inglés. Ejemplo: `T4.3-operation-repository.md`.

## Plantilla

```markdown
# T<id> · <Título>

| Campo | Valor |
|---|---|
| Estado | todo · in-progress · review · done |
| Requisitos | R… |
| Diseño | design.md §… |
| Depende de | T… |
| Ejecutor | Gemini · Claude Code |

## Objetivo
Una o dos frases con el resultado esperado.

## Contexto
Lo mínimo que el agente debe saber y que no está en AGENTS.md.

## Archivos
| Acción | Ruta | Contenido |
|---|---|---|
| crear | `src/...` | ... |

## Pasos
1. ...

## Restricciones
Reglas propias de esta tarea. Las de AGENTS.md aplican siempre.

## Trampas conocidas
Errores típicos de un agente en esta tarea. El revisor los busca explícitamente.

## Criterios de aceptación
- [ ] ...

## Verificación
    comandos

## Fuera de alcance
Lo que no se hace en esta tarea.

## Commit
`tipo(scope): descripción [T<id>]`

## Notas de revisión
Se llena al revisar: qué se corrigió y por qué.
```

## Índice

| Tarea | Plan | Estado |
|---|---|---|
| T2.1 | [T2.1-project-setup.md](T2.1-project-setup.md) | todo |
| T2.2 | [T2.2-docker-compose.md](T2.2-docker-compose.md) | todo |
| T2.3 | [T2.3-prisma-schema.md](T2.3-prisma-schema.md) | todo |
| T2.4 | [T2.4-config.md](T2.4-config.md) | todo |
| T2.5 | [T2.5-logger-correlation.md](T2.5-logger-correlation.md) | todo |
| T2.6 | [T2.6-app-factory-health.md](T2.6-app-factory-health.md) | todo |

Los planes de las fases 3 en adelante se escriben al cerrar la fase anterior, para que reflejen el código real.

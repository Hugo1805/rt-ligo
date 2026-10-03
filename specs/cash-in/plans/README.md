# Plans por tarea

Cada tarea de [tasks.md](../tasks.md) tiene aquí un plan ejecutable por un agente: Gemini, Antigravity o Claude Code.
El plan baja el spec al nivel de archivos, pasos y criterios de aceptación, para que el agente no tenga que inventar decisiones.

## Flujo

```
1. Planificar   Se escribe fase-<n>/T<id>-<slug>.md con la plantilla de abajo. Estado: todo.
2. Ejecutar     El agente ejecutor lee AGENTS.md y el plan, e implementa. Estado: in-progress.
3. Verificar    El agente corre los comandos de "Verificación". Todos en verde. Estado: review.
4. Revisar      Una persona u otro agente revisa el diff contra los criterios y las trampas conocidas.
5. Cerrar       Quien revisa marca la tarea en tasks.md, pasa el plan a done y hace el commit de la tarea.
```

Si la revisión encuentra un error del agente, se corrige y se anota en [docs/ai-log.md](../../../docs/ai-log.md) con quién lo detectó.

## Cómo pedirle una tarea a Gemini

Prompt para pegar en Gemini o Antigravity, cambiando el id:

```
Lee AGENTS.md y specs/cash-in/plans/fase-2/T2.1-project-setup.md.
Ejecuta solo ese plan. No toques archivos fuera de la sección "Archivos".
Cuando termines, corre los comandos de "Verificación" y muéstrame la salida.
Si algo del plan contradice los specs o no se puede cumplir, detente y explícalo antes de improvisar.
No hagas commit.
```

El commit lo hace quien revisa, después de validar el diff.

## Nombres y carpetas

Cada fase de `tasks.md` tiene su carpeta `fase-<n>/`, y dentro va un plan por tarea.
El archivo se llama `T<id>-<slug>.md`, con el id de `tasks.md` y un slug corto en inglés. Ejemplo: `fase-4/T4.3-operation-repository.md`.

## Paralelismo

La fila "Paralelo con" de cada plan lista las tareas que pueden ejecutarse a la vez sin tocar los mismos archivos.
Cada tarea en paralelo corre en su propio worktree de git y en su propia rama. Los ejecutores no editan `tasks.md` ni `docs/ai-log.md`: eso lo hace quien revisa, así se evitan conflictos al fusionar.

## Plantilla

```markdown
# T<id> · <Título>

| Campo | Valor |
|---|---|
| Estado | todo · in-progress · review · done |
| Requisitos | R… |
| Diseño | design.md §… |
| Depende de | T… |
| Paralelo con | T… |
| Ejecutor | Antigravity · Gemini · Claude Code |

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

Los planes de las fases 3 a 9 se escribieron antes del código. Antes de ejecutar uno, quien orquesta confirma que los nombres que cita de tareas previas coinciden con el código real.
Algunos planes tienen una sección de huecos del spec. Esos huecos se resuelven en `design.md` antes de ejecutar la tarea.

### Fase 2 · Base

| Tarea | Plan | Estado | Depende de | Paralelo con | Ejecutor |
|---|---|---|---|---|---|
| T2.1 | [T2.1-project-setup.md](fase-2/T2.1-project-setup.md) | done | T1.5 | — | Gemini |
| T2.2 | [T2.2-docker-compose.md](fase-2/T2.2-docker-compose.md) | done | T2.1 | — | Gemini |
| T2.3 | [T2.3-prisma-schema.md](fase-2/T2.3-prisma-schema.md) | done | T2.2 | — | Gemini |
| T2.4 | [T2.4-config.md](fase-2/T2.4-config.md) | done | T2.1 | T2.5, T3.1, T3.3, T3.4, T3.5 | Gemini |
| T2.5 | [T2.5-logger-correlation.md](fase-2/T2.5-logger-correlation.md) | done | T2.1 | T2.4, T3.1, T3.3, T3.4, T3.5 | Gemini |
| T2.6 | [T2.6-app-factory-health.md](fase-2/T2.6-app-factory-health.md) | done | T2.3, T2.4, T2.5 | T3.2, T3.6, T4.1 | Gemini |

### Fase 3 · Dominio puro

| Tarea | Plan | Estado | Depende de | Paralelo con | Ejecutor |
|---|---|---|---|---|---|
| T3.1 | [T3.1-state-machine.md](fase-3/T3.1-state-machine.md) | todo | T2.1 | T2.4, T2.5, T3.3, T3.4, T3.5 | Antigravity |
| T3.2 | [T3.2-errors-error-handler.md](fase-3/T3.2-errors-error-handler.md) | todo | T2.5 | T2.6, T4.1 | Antigravity |
| T3.3 | [T3.3-request-hash.md](fase-3/T3.3-request-hash.md) | todo | T2.1 | T2.4, T2.5, T3.1, T3.4, T3.5 | Antigravity |
| T3.4 | [T3.4-retry.md](fase-3/T3.4-retry.md) | todo | T2.1 | T2.4, T2.5, T3.1, T3.3, T3.5 | Antigravity |
| T3.5 | [T3.5-webhook-signature.md](fase-3/T3.5-webhook-signature.md) | todo | T2.1 | T2.4, T2.5, T3.1, T3.3, T3.4 | Antigravity |
| T3.6 | [T3.6-zod-schemas.md](fase-3/T3.6-zod-schemas.md) | todo | T3.2, T2.4 | T2.6, T4.1 | Antigravity |

### Fase 4 · Cash-in

| Tarea | Plan | Estado | Depende de | Paralelo con | Ejecutor |
|---|---|---|---|---|---|
| T4.1 | [T4.1-payment-provider.md](fase-4/T4.1-payment-provider.md) | todo | T2.1 | T2.6, T3.2, T3.6 | Antigravity |
| T4.2 | [T4.2-redis-lock.md](fase-4/T4.2-redis-lock.md) | todo | T2.6 | T4.3, T4.4 | Antigravity |
| T4.3 | [T4.3-operation-repository.md](fase-4/T4.3-operation-repository.md) | todo | T3.1, T2.6 | T4.2, T4.4 | Antigravity |
| T4.4 | [T4.4-db-retry.md](fase-4/T4.4-db-retry.md) | todo | T3.2, T3.4 | T4.2, T4.3, T4.5 | Antigravity |
| T4.5 | [T4.5-apply-credit.md](fase-4/T4.5-apply-credit.md) | todo | T4.3 | T4.2, T4.4 | Claude Code |
| T4.6 | [T4.6-cash-in-service.md](fase-4/T4.6-cash-in-service.md) | todo | T3.1, T3.2, T3.3, T3.4, T3.6, T4.1, T4.2, T4.3, T4.4, T4.5 | Ninguna | Claude Code |
| T4.7 | [T4.7-cash-in-routes.md](fase-4/T4.7-cash-in-routes.md) | todo | T4.6, T3.6, T2.6 | Ninguna | Antigravity |
| T4.8 | [T4.8-cash-in-integration-tests.md](fase-4/T4.8-cash-in-integration-tests.md) | todo | T4.7 | Ninguna | Antigravity |

### Fase 5 · Webhooks

| Tarea | Plan | Estado | Depende de | Paralelo con | Ejecutor |
|---|---|---|---|---|---|
| T5.1 | [T5.1-webhook-service.md](fase-5/T5.1-webhook-service.md) | todo | T3.1, T3.2, T4.4, T4.5 | T6.1, T6.2, T7.1, T8.1, T8.2 | Claude Code |
| T5.2 | [T5.2-webhook-routes.md](fase-5/T5.2-webhook-routes.md) | todo | T3.5, T3.6, T4.7, T5.1 | T6.1, T6.2, T7.1, T8.1, T8.2 | Antigravity |
| T5.3 | [T5.3-webhook-integration-tests.md](fase-5/T5.3-webhook-integration-tests.md) | todo | T4.7, T5.2 | T6.1, T6.2, T7.1, T8.1, T8.2 | Antigravity |

### Fase 6 · Reconciliador

| Tarea | Plan | Estado | Depende de | Paralelo con | Ejecutor |
|---|---|---|---|---|---|
| T6.1 | [T6.1-reconciler-lease.md](fase-6/T6.1-reconciler-lease.md) | todo | T4.1, T4.3, T4.5 | T5.1, T5.2, T5.3, T7.1, T8.1, T8.2 | Claude Code |
| T6.2 | [T6.2-reconciler-integration-tests.md](fase-6/T6.2-reconciler-integration-tests.md) | todo | T6.1 | T5.1, T5.2, T5.3, T7.1, T8.1, T8.2 | Antigravity |

### Fase 7 · E2E

| Tarea | Plan | Estado | Depende de | Paralelo con | Ejecutor |
|---|---|---|---|---|---|
| T7.1 | [T7.1-mock-psp-http-provider.md](fase-7/T7.1-mock-psp-http-provider.md) | todo | T4.1 | T5.1, T5.2, T5.3, T6.1, T6.2, T8.1 | Antigravity |
| T7.2 | [T7.2-dockerfile-e2e-profile.md](fase-7/T7.2-dockerfile-e2e-profile.md) | todo | T2.6, T7.1 | T8.1, T8.2 | Antigravity |
| T7.3 | [T7.3-e2e-tests.md](fase-7/T7.3-e2e-tests.md) | todo | T5.3, T6.2, T7.2 | T8.1, T8.2 | Antigravity |

### Fase 8 · Terraform

| Tarea | Plan | Estado | Depende de | Paralelo con | Ejecutor |
|---|---|---|---|---|---|
| T8.1 | [T8.1-terraform-aws.md](fase-8/T8.1-terraform-aws.md) | todo | — | Cualquier tarea desde T2.4. No toca código de la app. | Antigravity |
| T8.2 | [T8.2-terraform-validate.md](fase-8/T8.2-terraform-validate.md) | todo | T8.1 | Cualquier tarea de las fases 4 a 7. | Antigravity |

### Fase 9 · Documentación

| Tarea | Plan | Estado | Depende de | Paralelo con | Ejecutor |
|---|---|---|---|---|---|
| T9.1 | [T9.1-readme.md](fase-9/T9.1-readme.md) | todo | T2.1 a T8.2 | — | Claude Code |
| T9.2 | [T9.2-ai-log-close.md](fase-9/T9.2-ai-log-close.md) | todo | T9.1 | — | Claude Code |

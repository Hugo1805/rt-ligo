# Requirements · Wallet Cash-In

> Spec-driven development. Este documento define **qué** debe cumplir el servicio.
> El **cómo** está en [design.md](design.md) y el orden de trabajo en [tasks.md](tasks.md).
> Los criterios usan formato EARS: *CUANDO / SI / MIENTRAS … el sistema DEBE …*.

## Alcance

Servicio de recarga de saldo (Cash-In) de una wallet en PEN vía una pasarela de pagos externa.

Dentro del alcance:
- `POST /cash-in` y `POST /webhooks/payment`.
- Idempotencia real con múltiples pods.
- Máquina de estados de la operación.
- Webhooks duplicados y fuera de orden.
- Reconciliación de operaciones en estado incierto.
- Observabilidad con correlation ID.

Fuera del alcance:
- Autenticación del usuario. En producción `user_id` vendría del JWT y no del body.
- Alta de wallets. Se crean por seed.
- Reembolsos y cash-out.
- Multi-moneda. Solo PEN.

## Glosario

| Término | Significado |
|---|---|
| Operación | Un intento de cash-in identificado por `operation_id` (`op_*`). |
| Idempotency-Key | UUID que la app genera por intención de recarga y reenvía en cada reintento. |
| Huella | SHA-256 del body normalizado. Detecta una key reutilizada con otro payload. |
| Referencia | El `operation_id` enviado al proveedor como su propia idempotency key. |
| Asiento | Registro inmutable en el ledger que acredita una operación. |
| Pod | Una réplica del servicio. Puede haber N corriendo a la vez. |

## R1 · Crear cash-in

**Historia:** Como usuario quiero recargar saldo con mi tarjeta para tener fondos en mi wallet.

1. CUANDO llega `POST /cash-in` válido con `Idempotency-Key` nueva, el sistema DEBE crear una operación, cobrar al proveedor y acreditar el monto en la wallet.
2. CUANDO el cobro se confirma, el sistema DEBE responder `200` con `operation_id`, `status: "completed"`, `amount` y `new_balance`.
3. El sistema DEBE validar el body con un schema zod antes de cualquier efecto: sin lock, sin escritura en DB y sin llamada al proveedor.
4. El body DEBE tener `user_id` (string no vacío), `amount` (número > 0, máximo 2 decimales, tope configurable), `currency` (`"PEN"`) y `payment_method` (string no vacío).
5. SI el body trae campos no definidos en el schema, el sistema DEBE rechazarlo.
6. SI el body es inválido o no es JSON, el sistema DEBE responder `400 VALIDATION_ERROR` con la lista de campos inválidos.
7. SI el usuario no tiene wallet, el sistema DEBE responder `404 WALLET_NOT_FOUND` sin llamar al proveedor.
8. SI la moneda no coincide con la de la wallet, el sistema DEBE responder `422 CURRENCY_MISMATCH` sin llamar al proveedor.

## R2 · Idempotency-Key

1. SI falta el header `Idempotency-Key`, el sistema DEBE responder `400 IDEMPOTENCY_KEY_MISSING`.
2. SI el header no es un UUID, el sistema DEBE responder `400 IDEMPOTENCY_KEY_INVALID`. El header se valida con zod antes que el body.
3. La key DEBE tener alcance por usuario: `(user_id, idempotency_key)`.
4. CUANDO llega una key ya usada con la misma huella, el sistema DEBE devolver la misma operación con su estado actual y el header `Idempotent-Replayed: true`, sin volver a cobrar.
5. CUANDO llega una key ya usada con huella distinta, el sistema DEBE responder `422 IDEMPOTENCY_KEY_REUSED` sin efectos.
6. La garantía de idempotencia NO DEBE depender de memoria del proceso.

## R3 · Doble click y retry de la app

1. CUANDO dos o más requests con la misma key llegan casi al mismo tiempo, el sistema DEBE procesar a lo sumo uno.
2. Los demás DEBEN recibir el estado de la operación existente, o `409 OPERATION_IN_PROGRESS` con `Retry-After` si la operación aún no fue persistida.
3. CUANDO la app reintenta con la misma key tras un error `retryable: true`, el sistema DEBE ser seguro: un solo cobro y un solo abono.

## R4 · Múltiples pods concurrentes

1. MIENTRAS N pods atienden tráfico, la misma key recibida en varios pods a la vez DEBE producir exactamente una operación, un cobro y un asiento.
2. La garantía final DEBE residir en PostgreSQL mediante restricciones únicas.
3. Redis DEBE usarse como barrera rápida previa, no como única garantía.
4. SI Redis no está disponible, el sistema DEBE seguir siendo correcto usando solo PostgreSQL.

## R5 · Timeout del proveedor (pregunta central)

1. El sistema DEBE persistir la operación antes de llamar al proveedor.
2. El sistema DEBE enviar el `operation_id` como referencia e idempotency key del proveedor en todo cobro.
3. SI el proveedor no responde dentro del timeout, el sistema DEBE marcar la operación `UNKNOWN` y responder `202` con `status: "unknown"`.
4. El sistema NO DEBE emitir un cobro nuevo con otra referencia para una operación existente.
5. CUANDO la app reintenta con la misma key una operación `UNKNOWN`, el sistema DEBE devolver su estado actual sin cobrar de nuevo.
6. Una operación `UNKNOWN` DEBE resolverse por webhook o por el reconciliador (R10).

## R6 · Fallo del proveedor

1. CUANDO el proveedor rechaza el cobro, el sistema DEBE marcar la operación `FAILED`, no modificar el saldo y responder `422 PAYMENT_DECLINED` con `operation_id`.
2. El sistema NO DEBE reintentar un rechazo de negocio.
3. El sistema PUEDE reintentar errores técnicos del proveedor, siempre con la misma referencia, con backoff exponencial con jitter y un máximo de intentos configurable.

## R7 · Máquina de estados

1. Estados: `PENDING`, `PROCESSING`, `UNKNOWN`, `COMPLETED`, `FAILED`.
2. Transiciones permitidas: `PENDING→PROCESSING`, `PENDING→FAILED`, `PROCESSING→COMPLETED`, `PROCESSING→FAILED`, `PROCESSING→UNKNOWN`, `UNKNOWN→COMPLETED`, `UNKNOWN→FAILED`.
3. `COMPLETED` y `FAILED` DEBEN ser terminales e inmutables.
4. Toda transición DEBE ser atómica y condicionada al estado de origen, para que dos actores concurrentes no la apliquen dos veces.
5. SI una transición no es válida desde el estado actual, el sistema DEBE ignorarla y registrarla en logs, sin error hacia el proveedor.

## R8 · Saldo y race conditions

1. El abono DEBE ocurrir en la misma transacción que la transición a `COMPLETED` y la creación del asiento.
2. Una operación DEBE tener como máximo un asiento, garantizado por restricción única.
3. El incremento de saldo DEBE ser atómico en la base de datos, sin leer y luego escribir desde la aplicación.
4. CUANDO llegan muchas recargas concurrentes del mismo usuario con keys distintas, el saldo final DEBE ser la suma exacta.
5. `new_balance` DEBE ser el saldo resultante de ese abono y DEBE ser el mismo en cada replay.

## R9 · Webhooks

1. El sistema DEBE exponer `POST /webhooks/payment`.
2. SI la firma HMAC es inválida o el timestamp está fuera de la tolerancia, el sistema DEBE responder `401 WEBHOOK_SIGNATURE_INVALID` sin efectos.
3. Tras verificar la firma, el sistema DEBE validar el payload con un schema zod. SI es inválido, DEBE responder `400 VALIDATION_ERROR` sin efectos.
4. CUANDO llega un evento con `event_id` ya procesado, el sistema DEBE responder `200` sin efectos.
5. CUANDO llega `charge.succeeded`, el sistema DEBE llevar la operación a `COMPLETED` y acreditar una sola vez.
6. CUANDO llega `charge.failed`, el sistema DEBE llevar la operación a `FAILED` si aún no es terminal.
7. CUANDO llega un evento que no es una transición válida, por ejemplo `charge.failed` tras `COMPLETED`, el sistema DEBE ignorarlo, registrarlo como anomalía y responder `200`.
8. CUANDO el webhook llega antes de que termine el flujo síncrono, el resultado DEBE ser un solo abono y el flujo síncrono DEBE responder el estado final.
9. SI monto o moneda del evento no coinciden con la operación, el sistema NO DEBE acreditar y DEBE registrar una anomalía para revisión.
10. SI ocurre un error transitorio propio, el sistema DEBE responder `5xx` y NO DEBE marcar el evento como procesado, para que el reintento del proveedor lo reprocese.

## R10 · Reinicio del servicio y reconciliación

1. El estado de cada operación DEBE vivir en PostgreSQL, de modo que un reinicio no pierda operaciones en curso.
2. Un reconciliador DEBE tomar operaciones `PENDING`, `PROCESSING` o `UNKNOWN` más antiguas que un umbral configurable. Una `PENDING` nunca envió el cobro, así que el reconciliador lo envía con su misma referencia.
3. Para cada una DEBE consultar al proveedor por referencia y aplicar el resultado.
4. SI el proveedor no conoce la referencia, el reconciliador DEBE reenviar el cobro con la misma referencia.
5. Dos pods NO DEBEN reconciliar la misma operación a la vez.
6. Tras un máximo de intentos sin resolución, la operación DEBE quedar `UNKNOWN` con una alerta en logs para revisión manual, y el reconciliador NO DEBE volver a tomarla.

## R11 · Fallo temporal de base de datos

1. SI ocurre un error transitorio de PostgreSQL, el sistema DEBE reintentar la unidad de trabajo un número acotado de veces.
2. SI se agotan los reintentos, el sistema DEBE responder `503 SERVICE_UNAVAILABLE` con `retryable: true` y `Retry-After`.
3. Ningún reintento DEBE producir un doble cobro ni un doble abono.

## R12 · Formato de error

1. Todo error DEBE responderse como `application/problem+json` (RFC 9457) con `type`, `title`, `status`, `code`, `detail`, `request_id`, `retryable` y, cuando aplique, `operation_id` y `errors`.
2. `code` DEBE pertenecer al catálogo de [design.md](design.md#formato-de-error).
3. La respuesta NO DEBE exponer stack traces ni mensajes crudos del proveedor o de Prisma.

## R13 · Observabilidad

1. El sistema DEBE leer `X-Request-Id` del request o generar uno, y devolverlo en la respuesta.
2. El correlation ID DEBE propagarse al proveedor y a todos los logs del request.
3. Los logs DEBEN ser JSON estructurado e incluir `request_id`, `operation_id`, `user_id`, `idempotency_key` y cada transición de estado.

## R14 · Calidad y entrega

1. El acceso a datos DEBE usar exclusivamente el cliente Prisma y Prisma Migrate, sin SQL crudo.
2. DEBE haber tests unitarios, de integración contra Postgres y Redis reales, y e2e contra dos réplicas, todos con `bun:test`.
3. DEBE haber Docker Compose para el entorno local y Terraform para AWS.
4. El README DEBE explicar arquitectura, idempotencia, concurrencia, retry, webhooks y el pilotaje del agente IA.

## Trazabilidad con el challenge

| Escenario del PDF | Requisitos |
|---|---|
| Doble click del usuario | R2, R3 |
| Retry automático de la app | R2.4, R3.3 |
| Múltiples pods concurrentes | R4 |
| Timeout del proveedor | R5 |
| Webhook duplicado | R9.4 |
| Webhook fuera de orden | R7.5, R9.7 |
| Webhook antes que la respuesta del API | R9.8 |
| Fallo temporal de DB | R11 |
| Reinicio del servicio durante la operación | R10 |
| Race condition sobre el saldo | R8 |

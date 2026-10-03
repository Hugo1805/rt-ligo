import { z } from "zod";

export const webhookEventSchema = z.object({
  event_id: z.string().min(1),
  type: z.enum(["charge.succeeded", "charge.failed", "charge.pending"]),
  created_at: z.iso.datetime(),
  data: z.object({
    charge_id: z.string().min(1),
    reference: z.string().min(1),
    amount: z.number(),
    currency: z.string().length(3),
    failure_code: z.string().nullable(),
  }),
});

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

import { z } from "zod";

// Like `schema.partial()` for PATCH bodies, but omitted fields stay omitted.
// Zod's .partial() keeps each field's .default(), so a PATCH that leaves a
// field out would silently reset it (e.g. status → "collection", isPublic → false).
export function patchSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      key,
      ((field instanceof z.ZodDefault ? field.removeDefault() : field) as z.ZodType).optional(),
    ])
  );
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof T]: z.ZodOptional<T[K]> }>;
}

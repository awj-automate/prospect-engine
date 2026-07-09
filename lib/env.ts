import { z } from "zod";

/**
 * Centralized, fail-fast environment validation.
 *
 * Imported by both the web app (Next server) and the standalone worker, so it
 * must never reach for anything browser-specific. Parsing happens once at
 * module load; a bad/missing var throws a readable error and stops startup.
 */

const IntFromString = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().nonnegative());

const HourFromString = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().min(0).max(23));

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

    LEADSHARK_API_KEY: z.string().min(1, "LEADSHARK_API_KEY is required"),
    ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),

    WEB_RESEARCH_PROVIDER: z.enum(["perplexity", "linkup"]),
    PERPLEXITY_API_KEY: z.string().optional(),
    LINKUP_API_KEY: z.string().optional(),

    CONTACT_PROVIDER: z.enum(["leadmagic", "findymail"]),
    LEADMAGIC_API_KEY: z.string().optional(),
    FINDYMAIL_API_KEY: z.string().optional(),

    APP_PASSWORD: z.string().min(1, "APP_PASSWORD is required"),
    CRON_SECRET: z.string().min(1, "CRON_SECRET is required"),

    TZ: z.string().default("Europe/London"),

    DAILY_PERSON_ENRICH_CAP: IntFromString(50),
    DAILY_COMPANY_ENRICH_CAP: IntFromString(50),
    ENRICH_WINDOW_START_HOUR: HourFromString(8),
    ENRICH_WINDOW_END_HOUR: HourFromString(20),
    PERSON_ENRICH_SECTIONS: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v : "about,experience,education")),
  })
  .superRefine((val, ctx) => {
    if (val.WEB_RESEARCH_PROVIDER === "perplexity" && !val.PERPLEXITY_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PERPLEXITY_API_KEY"],
        message: "PERPLEXITY_API_KEY is required when WEB_RESEARCH_PROVIDER=perplexity",
      });
    }
    if (val.WEB_RESEARCH_PROVIDER === "linkup" && !val.LINKUP_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["LINKUP_API_KEY"],
        message: "LINKUP_API_KEY is required when WEB_RESEARCH_PROVIDER=linkup",
      });
    }
    if (val.CONTACT_PROVIDER === "leadmagic" && !val.LEADMAGIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["LEADMAGIC_API_KEY"],
        message: "LEADMAGIC_API_KEY is required when CONTACT_PROVIDER=leadmagic",
      });
    }
    if (val.CONTACT_PROVIDER === "findymail" && !val.FINDYMAIL_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FINDYMAIL_API_KEY"],
        message: "FINDYMAIL_API_KEY is required when CONTACT_PROVIDER=findymail",
      });
    }
    if (val.ENRICH_WINDOW_END_HOUR <= val.ENRICH_WINDOW_START_HOUR) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ENRICH_WINDOW_END_HOUR"],
        message: "ENRICH_WINDOW_END_HOUR must be greater than ENRICH_WINDOW_START_HOUR",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const flat = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // Fail fast, loudly, before anything else boots.
    throw new Error(`Invalid environment configuration:\n${flat}`);
  }
  return parsed.data;
}

/**
 * Lazily validated. `next build` imports every route module to collect page
 * data — at that point the Railway env vars aren't present. Validating on first
 * property access (rather than at import) lets the build succeed while still
 * failing fast on the first real request / at worker startup.
 */
let cached: Env | null = null;

export function getEnv(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

export const env: Env = new Proxy({} as Env, {
  get(_target, prop) {
    return getEnv()[prop as keyof Env];
  },
  has(_target, prop) {
    return prop in getEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(getEnv());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Object.getOwnPropertyDescriptor(getEnv(), prop);
  },
});

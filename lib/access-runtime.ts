import { env } from "./node-runtime";
import type { AccessConfig } from "./access";
export function siteAccessConfig():AccessConfig{return {verifier:env.SITE_ACCESS_VERIFIER,sessionSecret:env.SITE_SESSION_SECRET};}

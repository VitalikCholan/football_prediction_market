/**
 * Registers the extensionless-import resolve hook (see extensionless.mjs).
 * Used via: node --experimental-transform-types --import ./hooks/register.mjs
 */
import { register } from "node:module";

register("./extensionless.mjs", import.meta.url);

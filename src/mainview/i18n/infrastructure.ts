export * from "../../shared/infrastructure/model.ts";
import { INFRASTRUCTURE_TYPE_LABELS as types, INFRASTRUCTURE_ENVIRONMENT_LABELS as environments, infrastructureEnvironmentLabel as canonicalEnvironment, infrastructureStatusLabel as canonicalStatus } from "../../shared/infrastructure/model.ts";
import { staticLabel } from "./presentation";
const labels = <T extends Record<string, string>>(source: T): T => Object.defineProperties({}, Object.fromEntries(Object.entries(source).map(([key, value]) => [key, { enumerable: true, get: () => staticLabel(value) }]))) as T;
export const INFRASTRUCTURE_TYPE_LABELS = labels(types);
export const INFRASTRUCTURE_ENVIRONMENT_LABELS = labels(environments);
export const infrastructureEnvironmentLabel: typeof canonicalEnvironment = (environment, custom) => environment === "custom" ? canonicalEnvironment(environment, custom) : staticLabel(canonicalEnvironment(environment, custom));
export const infrastructureStatusLabel: typeof canonicalStatus = status => staticLabel(canonicalStatus(status));

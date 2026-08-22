export interface EnvironmentReference {
  fromEnvironment: string;
}

export interface OpSecretReference {
  fromOp: string;
}

export type EnvironmentBinding = string;

export type EnvironmentSetValue = string | OpSecretReference;

export type ResolvableString = string | EnvironmentReference;

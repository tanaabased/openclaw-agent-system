export interface EnvironmentReference {
  fromEnvironment: string;
}

export type EnvironmentBinding = string;

export type ResolvableString = string | EnvironmentReference;

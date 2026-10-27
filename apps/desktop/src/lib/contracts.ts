export type MaskedServiceConfig = {
  service: string;
  endpoint: string;
  apiKeyMask: string;
  credentialReference: string;
};

export type ServiceConfigurationInput = {
  service: string;
  endpoint: string;
  apiKey: string;
};

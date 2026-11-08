export const cleanAgentOptions = (config) => [
  ...(config.agent ? ["--agent", config.agent] : []),
  ...(config.model ? ["--model", config.model] : []),
];

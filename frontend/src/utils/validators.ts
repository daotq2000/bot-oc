export const proxyPattern = /^\d{1,3}(?:\.\d{1,3}){3}:\d+:.+:.+$/;
export const walletPattern = /^0x[a-fA-F0-9]{40}$/;

export const validateProxy = (value?: string) =>
  !value || proxyPattern.test(value);

export const validateWallet = (value?: string) =>
  !value || walletPattern.test(value);


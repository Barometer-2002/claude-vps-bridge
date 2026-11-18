import policy from './dependency-policy.json' with {type:'json'};

export const BRIDGE_PROTOCOL = policy.bridgeProtocol;
if (!Number.isSafeInteger(BRIDGE_PROTOCOL) || BRIDGE_PROTOCOL < 1) {
  throw new Error('Invalid bridgeProtocol in packaged dependency policy');
}

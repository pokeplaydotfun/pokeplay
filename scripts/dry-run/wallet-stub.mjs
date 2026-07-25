/**
 * A fake injected wallet for the browser pass.
 *
 * Returned as a string to hand to `page.addInitScript`, so it runs before any
 * app code and the EIP-6963 announcement is already in flight when wagmi starts
 * listening.
 *
 * Everything except account selection is forwarded straight to anvil, which
 * holds the keys for its own accounts and implements personal_sign,
 * eth_signTypedData_v4 and eth_sendTransaction for them. That keeps the stub
 * honest: transactions really are signed and really are mined.
 */
export function walletStub({ address, rpc, chainIdHex }) {
  return `
(() => {
  const ADDRESS = ${JSON.stringify(address)}
  const RPC = ${JSON.stringify(rpc)}
  const CHAIN = ${JSON.stringify(chainIdHex)}
  let id = 0

  const listeners = {}

  async function rpcCall(method, params) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }),
    })
    const json = await res.json()
    if (json.error) {
      const err = new Error(json.error.message || 'rpc error')
      err.code = json.error.code ?? -32000
      throw err
    }
    return json.result
  }

  const provider = {
    isMetaMask: true,
    _isStub: true,
    async request({ method, params }) {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [ADDRESS]
        case 'eth_chainId':
          return CHAIN
        case 'net_version':
          return String(parseInt(CHAIN, 16))
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          // Single-chain stub: already on it.
          return null
        case 'wallet_requestPermissions':
          return [{ parentCapability: 'eth_accounts' }]
        default:
          return rpcCall(method, params)
      }
    },
    on(event, fn) {
      (listeners[event] ||= []).push(fn)
    },
    removeListener(event, fn) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== fn)
    },
  }

  window.ethereum = provider

  // EIP-6963: the app only lists wallets that announce themselves this way.
  const detail = Object.freeze({
    info: Object.freeze({
      uuid: '11111111-2222-3333-4444-555555555555',
      name: 'Dry Run Wallet',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
      rdns: 'xyz.pokeplay.dryrun',
    }),
    provider,
  })

  const announce = () => window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', { detail }),
  )
  window.addEventListener('eip6963:requestProvider', announce)
  announce()
})()
`
}

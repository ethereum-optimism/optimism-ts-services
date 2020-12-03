import * as rlp from 'rlp'
import { BigNumber } from 'ethers'

import { toHexString } from './hex-utils'

export const encodeAccountState = (state: Partial<any>): Buffer => {
  return rlp.encode([
    state.nonce || 0,
    state.balance.toNumber() || 0,
    state.storageRoot || '0x' + '00'.repeat(32),
    state.codeHash || '0x' + '00'.repeat(32),
  ])
}

export const decodeAccountState = (state: Buffer): any => {
  const decoded = rlp.decode(state) as any
  return {
    nonce: decoded[0].length ? parseInt(toHexString(decoded[0]), 16) : 0,
    balance: decoded[1].length ? BigNumber.from(decoded[1]) : BigNumber.from(0),
    storageRoot: decoded[2].length ? toHexString(decoded[2]) : null,
    codeHash: decoded[3].length ? toHexString(decoded[3]) : null,
  }
}

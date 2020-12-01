import { JsonRpcProvider } from '@ethersproject/providers'

import { StateDiffProof } from '../../types'
import { toUnpaddedHexString } from '../hex-utils'

export class L2ProviderWrapper {
  constructor(public provider: JsonRpcProvider) {}

  public async getStateRoot(index: number): Promise<string> {
    const block = await this.provider.send('eth_getBlockByNumber', [toUnpaddedHexString(index), false])
    return block.stateRoot
  }

  public async getTransaction(index: number): Promise<string> {
    const transaction = await this.provider.send(
      'eth_getTransactionByBlockNumberAndIndex',
      [toUnpaddedHexString(index), '0x0']
    )

    return transaction.input
  }

  public async getStateDiffProof(index: number): Promise<StateDiffProof> {
    return this.provider.send('eth_getStateDiffProof', [toUnpaddedHexString(index)])
  }
}
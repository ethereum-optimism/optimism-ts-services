import { JsonRpcProvider } from '@ethersproject/providers'
import { ethers, Event, Contract } from 'ethers'
import { MerkleTree } from 'merkletreejs'

import {
  StateRootBatchHeader,
  StateRootBatchProof,
  TransactionBatchHeader,
  TransactionBatchProof,
} from '../../types/ovm.types'

export class L1ProviderWrapper {
  constructor(
    public provider: JsonRpcProvider,
    public OVM_StateCommitmentChain: Contract,
    public OVM_CanonicalTransactionChain: Contract
  ) {}

  public async getStateRootBatchHeader(
    index: number
  ): Promise<StateRootBatchHeader> {
    const event = await this._getStateRootBatchEvent(index)

    if (!event) {
      return
    }

    return {
      batchIndex: event.args._batchIndex,
      batchRoot: event.args._batchRoot,
      batchSize: event.args._batchSize,
      prevTotalElements: event.args._prevTotalElements,
      extraData: event.args._extraData,
    }
  }

  public async getBatchStateRoots(index: number): Promise<string[]> {
    const event = await this._getStateRootBatchEvent(index)

    if (!event) {
      return
    }

    const transaction = await this.provider.getTransaction(
      event.transactionHash
    )

    const [
      stateRoots,
    ] = this.OVM_StateCommitmentChain.interface.decodeFunctionData(
      'appendStateBatch',
      transaction.data
    )

    return stateRoots
  }

  public async getStateRootBatchProof(
    index: number
  ): Promise<StateRootBatchProof> {
    const batchHeader = await this.getStateRootBatchHeader(index)
    const stateRoots = await this.getBatchStateRoots(index)

    const elements = []
    for (
      let i = 0;
      i < Math.pow(2, Math.ceil(Math.log2(stateRoots.length)));
      i++
    ) {
      if (i < stateRoots.length) {
        elements.push(stateRoots[i])
      } else {
        elements.push('0x' + '00'.repeat(32))
      }
    }

    const hash = (el: Buffer | string): Buffer => {
      return Buffer.from(ethers.utils.keccak256(el).slice(2), 'hex')
    }

    const leaves = elements.map((element) => {
      return hash(element)
    })

    const tree = new MerkleTree(leaves, hash)
    const batchIndex = index - batchHeader.prevTotalElements.toNumber()
    const treeProof = tree.getProof(leaves[index], index).map((element) => {
      return element.data
    })

    return {
      stateRoot: stateRoots[batchIndex],
      stateRootBatchHeader: batchHeader,
      stateRootProof: {
        index: batchIndex,
        siblings: treeProof,
      },
    }
  }

  public async getTransactionBatchHeader(
    index: number
  ): Promise<TransactionBatchHeader> {
    const event = await this._getTransactionBatchEvent(index)
    
    if (!event) {
      return
    }

    return {
      batchIndex: event.args._batchIndex,
      batchRoot: event.args._batchRoot,
      batchSize: event.args._batchSize,
      prevTotalElements: event.args._prevTotalElements,
      extraData: event.args._extraData,
    }
  }

  public async getBatchTransactions(index: number): Promise<string> {
    const event = await this._getTransactionBatchEvent(index)

    if (!event) {
      return
    }

    const transaction = await this.provider.getTransaction(
      event.transactionHash
    )

    const [
      transactions,
    ] = this.OVM_StateCommitmentChain.interface.decodeFunctionData(
      'appendTransactionBatch',
      transaction.data
    )

    return transactions
  }

  public async getTransactionBatchProof(
    index: number
  ): Promise<TransactionBatchProof> {
    const batchHeader = await this.getTransactionBatchHeader(index)
    const transactions = await this.getBatchTransactions(index)

    const elements = []
    for (
      let i = 0;
      i < Math.pow(2, Math.ceil(Math.log2(transactions.length)));
      i++
    ) {
      if (i < transactions.length) {
        elements.push(transactions[i])
      } else {
        elements.push('0x' + '00'.repeat(32))
      }
    }

    const hash = (el: Buffer | string): Buffer => {
      return Buffer.from(ethers.utils.keccak256(el).slice(2), 'hex')
    }

    const leaves = elements.map((element) => {
      return hash(element)
    })

    const tree = new MerkleTree(leaves, hash)
    const batchIndex = index - batchHeader.prevTotalElements.toNumber()
    const treeProof = tree.getProof(leaves[index], index).map((element) => {
      return element.data
    })

    return {
      transaction: transactions[batchIndex],
      transactionBatchHeader: batchHeader,
      transactionProof: {
        index: batchIndex,
        siblings: treeProof,
      },
    }
  }

  private async _getStateRootBatchEvent(index: number): Promise<Event> {
    const filter = this.OVM_StateCommitmentChain.filters.StateBatchAppended()
    const events = await this.OVM_StateCommitmentChain.queryFilter(filter)

    if (events.length === 0) {
      return
    }

    return events.find((event) => {
      return (
        event.args._prevTotalElements.toNumber() <= index &&
        event.args._prevTotalElements.toNumber() +
          event.args._batchSize.toNumber() >
          index
      )
    })
  }

  private async _getTransactionBatchEvent(index: number): Promise<Event> {
    const filter = this.OVM_CanonicalTransactionChain.filters.TransactionBatchAppended()
    const events = await this.OVM_CanonicalTransactionChain.queryFilter(filter)

    if (events.length === 0) {
      return
    }

    return events.find((event) => {
      return (
        event.args._prevTotalElements.toNumber() <= index &&
        event.args._prevTotalElements.toNumber() +
          event.args._batchSize.toNumber() >
          index
      )
    })
  }
}

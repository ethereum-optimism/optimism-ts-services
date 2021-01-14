/* Imports: External */
import { Contract, ethers, Wallet, BigNumber } from 'ethers'
import { JsonRpcProvider } from '@ethersproject/providers'
import * as rlp from 'rlp'
import { MerkleTree } from 'merkletreejs'

/* Imports: Internal */
import { BaseService } from './base.service'
import SpreadSheet from '../utils/spreadsheet'

import {
  sleep,
  loadContract,
  loadContractFromManager,
  loadProxyFromManager,
  fromHexString,
} from '../utils'
import { StateRootBatchHeader, SentMessage, SentMessageProof } from '../types'

interface MessageRelayerOptions {
  // Providers for interacting with L1 and L2.
  l1RpcProvider: JsonRpcProvider
  l2RpcProvider: JsonRpcProvider

  // Address of the AddressManager contract, used to resolve the various addresses we'll need
  // within this service.
  addressManagerAddress: string

  // Wallet instance, used to sign and send the L1 relay transactions.
  l1Wallet: Wallet

  // Max gas to relay messages with.
  relayGasLimit: number

  // Height of the L2 transaction to start searching for L2->L1 messages.
  fromL2TransactionIndex?: number

  // Interval in seconds to wait between loops.
  pollingInterval?: number

  // Number of blocks that L2 is "ahead" of transaction indices. Can happen if blocks are created
  // on L2 after the genesis but before the first state commitment is published.
  l2BlockOffset?: number

  // L1 block to start querying events from. Recommended to set to the StateCommitmentChain deploy height
  l1StartOffset?: number

  // Number of blocks within each getLogs query - max is 2000
  getLogsInterval?: number

  // Append txs to a spreadsheet instead of submitting transactions
  spreadsheetMode?: boolean
  spreadsheet?: SpreadSheet
}

export class MessageRelayerService extends BaseService<MessageRelayerOptions> {
  protected name = 'Message Relayer'
  protected defaultOptions = {
    relayGasLimit: 4_000_000,
    fromL2TransactionIndex: 0,
    pollingInterval: 5000,
    l2BlockOffset: 1,
    l1StartOffset: 0,
    getLogsInterval: 2000,
    spreadsheetMode: false,
  }

  protected spreadsheetMode: boolean
  protected spreadsheet: SpreadSheet

  private state: {
    lastFinalizedTxHeight: number
    nextUnfinalizedTxHeight: number
    lastQueriedL1Block: number
    eventCache: ethers.Event[]
    Lib_AddressManager: Contract
    OVM_StateCommitmentChain: Contract
    OVM_L1CrossDomainMessenger: Contract
    OVM_L2CrossDomainMessenger: Contract
    OVM_L2ToL1MessagePasser: Contract
  }

  protected async _init(): Promise<void> {
    this.logger.info(
      `Initializing message relayer with options: ${this.options}`
    )
    // Need to improve this, sorry.
    this.state = {} as any

    const address = await this.options.l1Wallet.getAddress()
    this.logger.info(`Using L1 EOA: ${address}`)

    this.state.Lib_AddressManager = loadContract(
      'Lib_AddressManager',
      this.options.addressManagerAddress,
      this.options.l1RpcProvider
    )

    this.logger.info('Connecting to OVM_StateCommitmentChain...')
    this.state.OVM_StateCommitmentChain = await loadContractFromManager(
      'OVM_StateCommitmentChain',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_StateCommitmentChain at address: ${this.state.OVM_StateCommitmentChain.address}`
    )

    this.logger.info('Connecting to OVM_L1CrossDomainMessenger...')
    this.state.OVM_L1CrossDomainMessenger = await loadProxyFromManager(
      'OVM_L1CrossDomainMessenger',
      'Proxy__OVM_L1CrossDomainMessenger',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_L1CrossDomainMessenger at address: ${this.state.OVM_L1CrossDomainMessenger.address}`
    )

    this.logger.info('Connecting to OVM_L2CrossDomainMessenger...')
    this.state.OVM_L2CrossDomainMessenger = await loadContractFromManager(
      'OVM_L2CrossDomainMessenger',
      this.state.Lib_AddressManager,
      this.options.l2RpcProvider
    )
    this.logger.info(
      `Connected to OVM_L2CrossDomainMessenger at address: ${this.state.OVM_L2CrossDomainMessenger.address}`
    )

    this.logger.info('Connecting to OVM_L2ToL1MessagePasser...')
    this.state.OVM_L2ToL1MessagePasser = loadContract(
      'OVM_L2ToL1MessagePasser',
      '0x4200000000000000000000000000000000000000',
      this.options.l2RpcProvider
    )
    this.logger.info(
      `Connected to OVM_L2ToL1MessagePasser at address: ${this.state.OVM_L2ToL1MessagePasser.address}`
    )

    this.logger.success('Connected to all contracts.')

    if (this.options.spreadsheetMode) {
      this.logger.info('Running in spreadsheet mode')
    }

    this.state.lastQueriedL1Block = this.options.l1StartOffset
    this.state.eventCache = []

    this.state.lastFinalizedTxHeight = this.options.fromL2TransactionIndex || 0
    this.state.nextUnfinalizedTxHeight =
      this.options.fromL2TransactionIndex || 0
  }

  protected async _start(): Promise<void> {
    while (this.running) {
      await sleep(this.options.pollingInterval)

      try {
        this.logger.info('Checking for newly finalized transactions...')
        if (
          !(await this._isTransactionFinalized(
            this.state.nextUnfinalizedTxHeight
          ))
        ) {
          this.logger.info(
            `Didn't find any newly finalized transactions. Trying again in ${Math.floor(
              this.options.pollingInterval / 1000
            )} seconds...`
          )
          continue
        }

        this.state.lastFinalizedTxHeight = this.state.nextUnfinalizedTxHeight
        while (
          await this._isTransactionFinalized(this.state.nextUnfinalizedTxHeight)
        ) {
          const size = (
            await this._getStateBatchHeader(this.state.nextUnfinalizedTxHeight)
          ).batch.batchSize.toNumber()
          this.logger.info(
            `Found a batch with ${size} finalized transaction(s), checking for more...`
          )
          this.state.nextUnfinalizedTxHeight += size
        }

        this.logger.interesting(
          `Found a total of ${
            this.state.nextUnfinalizedTxHeight -
            this.state.lastFinalizedTxHeight
          } finalized transaction(s).`
        )

        const messages = await this._getSentMessages(
          this.state.lastFinalizedTxHeight,
          this.state.nextUnfinalizedTxHeight
        )

        if (messages.length === 0) {
          this.logger.interesting(
            `Didn't find any L2->L1 messages. Trying again in ${Math.floor(
              this.options.pollingInterval / 1000
            )} seconds...`
          )
        }

        for (const message of messages) {
          this.logger.interesting(
            `Found a message sent during transaction: ${message.parentTransactionIndex}`
          )
          if (await this._wasMessageRelayed(message)) {
            this.logger.interesting(
              `Message has already been relayed, skipping.`
            )
            continue
          }

          this.logger.interesting(
            `Message not yet relayed. Attempting to generate a proof...`
          )
          const proof = await this._getMessageProof(message)
          this.logger.interesting(
            `Successfully generated a proof. Attempting to relay to Layer 1...`
          )

          await this._relayMessageToL1(message, proof)
        }

        this.logger.interesting(
          `Finished searching through newly finalized transactions. Trying again in ${Math.floor(
            this.options.pollingInterval / 1000
          )} seconds...`
        )
      } catch (err) {
        this.logger.error(
          `Caught an unhandled error, see error log below:\n\n${err}\n`
        )
      }
    }
  }

  private async _getStateBatchHeader(
    height: number
  ): Promise<
    | {
        batch: StateRootBatchHeader
        stateRoots: string[]
      }
    | undefined
  > {
    const filter = this.state.OVM_StateCommitmentChain.filters.StateBatchAppended()

    let startingBlock = this.state.lastQueriedL1Block
    while (
      startingBlock < (await this.options.l1RpcProvider.getBlockNumber())
    ) {
      this.state.lastQueriedL1Block = startingBlock
      this.logger.info(
        `Querying events from L1 block ${startingBlock} to ${
          startingBlock + this.options.getLogsInterval
        }...`
      )
      const events: ethers.Event[] = await this.state.OVM_StateCommitmentChain.queryFilter(
        filter,
        startingBlock,
        startingBlock + this.options.getLogsInterval
      )

      this.state.eventCache = this.state.eventCache.concat(events)
      startingBlock += this.options.getLogsInterval
    }

    // tslint:disable-next-line
    const event = this.state.eventCache.find((event) => {
      return (
        event.args._prevTotalElements.toNumber() <= height &&
        event.args._prevTotalElements.toNumber() +
          event.args._batchSize.toNumber() >
          height
      )
    })

    if (event) {
      const transaction = await this.options.l1RpcProvider.getTransaction(
        event.transactionHash
      )
      const [
        stateRoots,
      ] = this.state.OVM_StateCommitmentChain.interface.decodeFunctionData(
        'appendStateBatch',
        transaction.data
      )

      return {
        batch: {
          batchIndex: event.args._batchIndex,
          batchRoot: event.args._batchRoot,
          batchSize: event.args._batchSize,
          prevTotalElements: event.args._prevTotalElements,
          extraData: event.args._extraData,
        },
        stateRoots,
      }
    }

    return
  }

  private async _isTransactionFinalized(height: number): Promise<boolean> {
    this.logger.info(`Checking if tx is finalized at height: ${height}`)
    const header = await this._getStateBatchHeader(height)

    if (header === undefined) {
      this.logger.info(`No state batch header found.`)
      return false
    } else {
      this.logger.info(
        `Got state batch header: ${JSON.stringify(header, null, 2)}`
      )
    }

    return !(await this.state.OVM_StateCommitmentChain.insideFraudProofWindow(
      header.batch
    ))
  }

  private async _getSentMessages(
    startHeight: number,
    endHeight: number
  ): Promise<SentMessage[]> {
    const filter = this.state.OVM_L2CrossDomainMessenger.filters.SentMessage()
    const events = await this.state.OVM_L2CrossDomainMessenger.queryFilter(
      filter,
      startHeight + this.options.l2BlockOffset,
      endHeight + this.options.l2BlockOffset - 1
    )

    return events.map((event) => {
      const message = event.args.message
      const decoded = this.state.OVM_L2CrossDomainMessenger.interface.decodeFunctionData(
        'relayMessage',
        message
      )

      return {
        target: decoded._target,
        sender: decoded._sender,
        message: decoded._message,
        messageNonce: decoded._messageNonce,
        encodedMessage: message,
        encodedMessageHash: ethers.utils.keccak256(message),
        parentTransactionIndex: event.blockNumber - this.options.l2BlockOffset,
        parentTransactionHash: event.transactionHash,
      }
    })
  }

  private async _wasMessageRelayed(message: SentMessage): Promise<boolean> {
    return this.state.OVM_L1CrossDomainMessenger.successfulMessages(
      message.encodedMessageHash
    )
  }

  private async _getMessageProof(
    message: SentMessage
  ): Promise<SentMessageProof> {
    const messageSlot = ethers.utils.keccak256(
      ethers.utils.keccak256(
        message.encodedMessage +
          this.state.OVM_L2CrossDomainMessenger.address.slice(2)
      ) + '00'.repeat(32)
    )

    // TODO: Complain if the proof doesn't exist.
    const proof = await this.options.l2RpcProvider.send('eth_getProof', [
      this.state.OVM_L2ToL1MessagePasser.address,
      [messageSlot],
      '0x' +
        BigNumber.from(
          message.parentTransactionIndex + this.options.l2BlockOffset
        )
          .toHexString()
          .slice(2)
          .replace(/^0+/, ''),
    ])

    // TODO: Complain if the batch doesn't exist.
    const header = await this._getStateBatchHeader(
      message.parentTransactionIndex
    )

    const elements = []
    for (
      let i = 0;
      i < Math.pow(2, Math.ceil(Math.log2(header.stateRoots.length)));
      i++
    ) {
      if (i < header.stateRoots.length) {
        elements.push(header.stateRoots[i])
      } else {
        elements.push(ethers.utils.keccak256('0x' + '00'.repeat(32)))
      }
    }

    const hash = (el: Buffer | string): Buffer => {
      return Buffer.from(ethers.utils.keccak256(el).slice(2), 'hex')
    }

    const leaves = elements.map((element) => {
      return fromHexString(element)
    })

    const tree = new MerkleTree(leaves, hash)
    const index =
      message.parentTransactionIndex - header.batch.prevTotalElements.toNumber()
    const treeProof = tree.getProof(leaves[index], index).map((element) => {
      return element.data
    })

    return {
      stateRoot: header.stateRoots[index],
      stateRootBatchHeader: header.batch,
      stateRootProof: {
        index,
        siblings: treeProof,
      },
      stateTrieWitness: rlp.encode(proof.accountProof),
      storageTrieWitness: rlp.encode(proof.storageProof[0].proof),
    }
  }

  private async _relayMessageToL1(
    message: SentMessage,
    proof: SentMessageProof
  ): Promise<void> {
    if (this.options.spreadsheetMode) {
      try {
        await this.options.spreadsheet.addRow({
          target: message.target,
          sender: message.sender,
          message: message.message,
          messageNonce: message.messageNonce.toString(),
          encodedMessage: message.encodedMessage,
          encodedMessageHash: message.encodedMessageHash,
          parentTransactionIndex: message.parentTransactionIndex,
          parentTransactionHash: message.parentTransactionIndex,
          stateRoot: proof.stateRoot,
          batchIndex: proof.stateRootBatchHeader.batchIndex.toString(),
          batchRoot: proof.stateRootBatchHeader.batchRoot,
          batchSize: proof.stateRootBatchHeader.batchSize.toString(),
          prevTotalElements: proof.stateRootBatchHeader.prevTotalElements.toString(),
          extraData: proof.stateRootBatchHeader.extraData,
          index: proof.stateRootProof.index,
          siblings: proof.stateRootProof.siblings.join(','),
          stateTrieWitness: proof.stateTrieWitness.toString('hex'),
          storageTrieWitness: proof.storageTrieWitness.toString('hex'),
        })
        this.logger.info('Submitted relay message to spreadsheet')
      } catch (e) {
        this.logger.error('Cannot submit message to spreadsheet')
        this.logger.error(e.message)
      }
    } else {
      try {
        this.logger.info(
          'Dry-run, checking to make sure proof would succeed...'
        )

        await this.state.OVM_L1CrossDomainMessenger.connect(
          this.options.l1Wallet
        ).callStatic.relayMessage(
          message.target,
          message.sender,
          message.message,
          message.messageNonce,
          proof,
          {
            gasLimit: this.options.relayGasLimit,
          }
        )

        this.logger.info(
          'Proof should succeed. Submitting for real this time...'
        )
      } catch (err) {
        this.logger.error(
          `Proof would fail, skipping. See error message below:\n\n${err.message}\n`
        )
        return
      }

      const result = await this.state.OVM_L1CrossDomainMessenger.connect(
        this.options.l1Wallet
      ).relayMessage(
        message.target,
        message.sender,
        message.message,
        message.messageNonce,
        proof,
        {
          gasLimit: this.options.relayGasLimit,
        }
      )

      try {
        const receipt = await result.wait()

        this.logger.interesting(
          `Relay message transaction sent, hash is: ${receipt.transactionHash}`
        )
      } catch (err) {
        this.logger.error(
          `Real relay attempt failed, skipping. See error message below:\n\n${err.message}\n`
        )
        return
      }
      this.logger.success(`Message successfully relayed to Layer 1!`)
    }
  }
}

import { BaseService } from './base.service'
import { sleep } from 'src/utils/common'

interface FraudProverOptions {
  pollingInterval: number
}

export class FraudProverService extends BaseService<FraudProverOptions> {
  protected name = 'Fraud Prover'
  protected defaultOptions = {
    pollingInterval: 5000,
  }

  protected async _start(): Promise<void> {
    while (this.running) {
      await sleep(this.options.pollingInterval)

      try {

      } catch (err) {
        this.logger.error(
          `Caught an unhandled error, see error log below:\n\n${err}\n`
        )
      }
    }
  }

  /**
   * @return Index of the earliest transaction that the node considers to be fraudulent.
   */
  private async _getEarliestFraudulentTx(): Promise<number> {
    throw new Error('TODO: Implement me')
  }

  /**
   * Queries the node for the core information necessary to carry out a fraud proof.
   * @param transactionIndex Index of the transaction to query data for.
   * @return Core fraud proof data for the given transaction.
   */
  private async _getTxFraudProofData(transactionIndex: number): Promise<FraudProofData> {
    throw new Error('TODO: Implement me')
  }

  private async 

}

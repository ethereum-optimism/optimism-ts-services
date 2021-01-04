import colors from 'colors/safe'

/**
 * A small logging utility.
 */
export class Logger {
  /**
   * @param namespace Namespace to attribute logs to.
   */
  constructor(public namespace: string) {}

  /**
   * For printing basic informational logs.
   * @param message Message to print.
   */
  public info(message: string): void {
    this._log(message, 'INFO', 'cyan')
  }

  /**
   * For printing service status logs.
   * @param message Message to print.
   */
  public status(message: string): void {
    this._log(message, 'STATUS', 'magenta')
  }

  /**
   * For printing potentially interesting logs.
   * @param message Message to print.
   */
  public interesting(message: string): void {
    this._log(message, 'INFO', 'yellow')
  }

  /**
   * For printing logs representing a success.
   * @param message Message to print.
   */
  public success(message: string): void {
    this._log(message, 'SUCCESS', 'green')
  }

  /**
   * For printing logs representing an error.
   * @param message Message to print.
   */
  public error(message: string): void {
    this._log(message, 'ERROR', 'red')
  }

  /**
   * Internal logging function.
   * @param message Message to print.
   * @param category Category to attach to the message.
   * @param color Color to print the log with.
   */
  private _log(message: string, category: string, color: string): void {
    // tslint:disable-next-line
    console.log(
      `${colors[color](`[${this.namespace}] [${category}]`)}: ${message}`
    )
  }
}

export interface Notifier {
  notifyPatientOrderReady(orderId: number): Promise<void>
  /** Only for orders the patient had already been sent. */
  notifyPatientOrderCancelled(orderId: number): Promise<void>
}

export class ConsoleNotifier implements Notifier {
  async notifyPatientOrderReady(orderId: number) {
    console.log(`[notifier] order ${orderId} is ready for patient payment`)
  }

  async notifyPatientOrderCancelled(orderId: number) {
    console.log(`[notifier] order ${orderId} was cancelled by the provider`)
  }
}

/** Records notifications instead of logging; for tests. */
export class RecordingNotifier implements Notifier {
  readonly sent: number[] = []
  readonly cancelled: number[] = []

  async notifyPatientOrderReady(orderId: number) {
    this.sent.push(orderId)
  }

  async notifyPatientOrderCancelled(orderId: number) {
    this.cancelled.push(orderId)
  }
}

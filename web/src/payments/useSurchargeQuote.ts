import { useEffect, useState } from 'react'
import { quoteSurcharge, SurchargeQuote } from '../api/payments'
import { chargeableUntil, inputKey, QUOTE_DEBOUNCE_MS, quoteInput, QuoteResult, quoteView, requoteAt, timerDelay } from './quote'

/**
 * Quotes the form's real amount and BIN, debounced, and re-quotes before the quote expires.
 *
 * @returns `view`, what the summary shows (only a `ready` view can be charged); `latestQuote`,
 * the last quote received, for the card label; and `requote`, which drops the current quote
 * and fetches a fresh one
 */
export const useSurchargeQuote = (amount: number | null | undefined, cardNumber: string | null | undefined) => {
  const [ result, setResult ] = useState<QuoteResult>()
  const [ latestQuote, setLatestQuote ] = useState<SurchargeQuote>()
  const [ now, setNow ] = useState(() => Date.now())
  const [ requotes, setRequotes ] = useState(0)

  const input = quoteInput(amount, cardNumber)
  const quoteAmount = input?.amount
  const quoteBin = input?.bin

  useEffect(() => {
    if (quoteAmount === undefined || quoteBin === undefined) return
    const key = inputKey({ amount: quoteAmount, bin: quoteBin })
    // Only the response for the latest values counts; a superseded request is cancelled
    const controller = new AbortController()
    const timer = setTimeout(() => {
      quoteSurcharge(quoteAmount, quoteBin, controller.signal)
        .then(quote => {
          if (controller.signal.aborted) return
          const receivedAtMs = Date.now()
          setNow(receivedAtMs)
          setResult({ key, quote, receivedAtMs })
          setLatestQuote(quote)
        })
        .catch(error => { if (!controller.signal.aborted) setResult({ key, error }) })
    }, QUOTE_DEBOUNCE_MS)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [quoteAmount, quoteBin, requotes])

  useEffect(() => {
    if (!result || !('quote' in result)) return
    const requote = requoteAt(result)
    const until = chargeableUntil(result)
    if (requote === null || until === null) return

    const check = () => {
      const t = Date.now()
      setNow(t)
      if (t >= requote) setRequotes(n => n + 1)
    }
    // A hidden tab's timers can be delayed for minutes, so check again when it's shown
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    const timers = [
      setTimeout(() => setRequotes(n => n + 1), timerDelay(requote, Date.now())),
      // If the re-quote is slow, the old quote still has to stop being chargeable on time
      setTimeout(() => setNow(Date.now()), timerDelay(until, Date.now())),
    ]
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      timers.forEach(clearTimeout)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [result])

  return {
    view: quoteView(amount, cardNumber, result, now),
    latestQuote,
    requote: () => {
      setResult(undefined)
      setRequotes(n => n + 1)
    },
  }
}

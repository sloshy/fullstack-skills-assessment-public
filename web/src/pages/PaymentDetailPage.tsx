import { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Descriptions, Popconfirm, Result, Space, Spin, Typography } from 'antd'
import dayjs from 'dayjs'
import { Link, useParams } from 'react-router-dom'
import { ApiError, errorMessage } from '../api/client'
import { getPayment, Payment, refundPayment } from '../api/payments'
import { CardLabel } from '../components/CardLabel'
import { StatusTag } from '../components/StatusTag'
import { classifyWriteError } from '../payments/writeErrors'
import { formatMinorUnits, formatMoney } from '../utils/money'

const { Text } = Typography

export const PaymentDetailPage = () => {
  const { id = '' } = useParams()
  const { message } = App.useApp()
  const [ payment, setPayment ] = useState<Payment>()
  const [ loading, setLoading ] = useState(true)
  const [ error, setError ] = useState<unknown>()
  const [ refunding, setRefunding ] = useState(false)
  // DECISIONS.md 016: while this is set, Refund stays off until the operator has checked
  const [ unknownRefundAt, setUnknownRefundAt ] = useState<Date>()
  const [ refreshing, setRefreshing ] = useState(false)
  const [ refreshError, setRefreshError ] = useState<string>()

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(undefined)

    getPayment(id)
      .then(p => { if (active) setPayment(p) })
      .catch(e => { if (active) setError(e) })
      .finally(() => { if (active) setLoading(false) })

    return () => { active = false }
  }, [id])

  const refund = async () => {
    setRefunding(true)
    setUnknownRefundAt(undefined)
    setRefreshError(undefined)
    try {
      setPayment(await refundPayment(id))
      message.success('Payment refunded')
    } catch (e) {
      const failure = classifyWriteError(e)
      if (failure.kind === 'unknown') setUnknownRefundAt(new Date())
      else message.error(failure.message)
    } finally {
      setRefunding(false)
    }
  }

  // Reloads in place: a failure here mustn't replace the page and lose the warning
  const refresh = async () => {
    setRefreshing(true)
    setRefreshError(undefined)
    try {
      const p = await getPayment(id)
      setPayment(p)
      if (p.status !== 'APPROVED') setUnknownRefundAt(undefined)
    } catch (e) {
      setRefreshError(errorMessage(e))
    } finally {
      setRefreshing(false)
    }
  }

  if (loading) {
    return (
      <div className='app-loading'>
        <Spin size='large' />
      </div>
    )
  }

  if (error instanceof ApiError && error.status === 404) {
    return <Result status='404' title='Payment not found' extra={<Link to='/'><Button>Back to payments</Button></Link>} />
  }

  if (error || !payment) {
    return <Alert type='error' showIcon message="Couldn't load this payment" description={errorMessage(error)} />
  }

  const money = (value: number) => formatMoney(value, payment.currency)

  return (
    <>
      <header className='page-header'>
        <div>
          <Link to='/' className='back-link'>← Payments</Link>
          <h1>{money(payment.total)} <StatusTag status={payment.status} /></h1>
        </div>
        {payment.status === 'APPROVED' &&
          <Popconfirm
            disabled={!!unknownRefundAt}
            title='Refund this payment?'
            description={`${money(payment.total)} will be returned to the customer's card.`}
            okText='Refund'
            onConfirm={refund}
          >
            <Button
              danger
              loading={refunding}
              disabled={!!unknownRefundAt}
              aria-describedby={unknownRefundAt ? 'unknown-refund' : undefined}
            >
              Refund
            </Button>
          </Popconfirm>
        }
      </header>

      {unknownRefundAt &&
        <Alert
          type='warning'
          showIcon
          message="We couldn't confirm whether this refund went through."
          description={<span id='unknown-refund'>
            {money(payment.total)} at {dayjs(unknownRefundAt).format('HH:mm:ss')}.
            {' '}Wait a moment, then refresh this payment and check its status before refunding again.
            {refreshError && <Text type='danger' style={{ display: 'block', marginTop: 8 }}>Couldn&apos;t refresh: {refreshError}</Text>}
          </span>}
          action={
            <Space direction='vertical'>
              <Button size='small' block loading={refreshing} onClick={refresh}>Refresh</Button>
              <Button size='small' block onClick={() => { setUnknownRefundAt(undefined); setRefreshError(undefined) }}>I&apos;ve checked</Button>
            </Space>
          }
          style={{ marginBottom: 16 }}
        />
      }

      <Card style={{ marginBottom: 16 }}>
        <Descriptions column={{ xs: 1, sm: 2 }} bordered size='middle'>
          <Descriptions.Item label='Customer'>{payment.customerName ?? 'Walk-in customer'}</Descriptions.Item>
          <Descriptions.Item label='Date'>{dayjs(payment.createdAt).format('MMM D, YYYY h:mm:ss A')}</Descriptions.Item>
          <Descriptions.Item label='Card'>
            <CardLabel network={payment.card.network} type={payment.card.type} last4={payment.card.last4} />
          </Descriptions.Item>
          <Descriptions.Item label='Payment ID'><code>{payment.id}</code></Descriptions.Item>
          <Descriptions.Item label='Amount'>{money(payment.amount)}</Descriptions.Item>
          <Descriptions.Item label='Surcharge'>{money(payment.surcharge)}</Descriptions.Item>
          <Descriptions.Item label='Total'><strong>{money(payment.total)}</strong></Descriptions.Item>
          <Descriptions.Item label='Refunded'>{money(payment.refundedAmount)}</Descriptions.Item>
          {payment.declineReason &&
            <Descriptions.Item label='Decline reason' span={2}>{payment.declineReason.replace(/_/g, ' ')}</Descriptions.Item>
          }
        </Descriptions>
      </Card>

      <Card title='Gateway' style={{ marginBottom: 16 }}>
        <Descriptions column={{ xs: 1, sm: 2 }} size='small'>
          <Descriptions.Item label='Reference'><code>{payment.gateway.reference ?? '—'}</code></Descriptions.Item>
          <Descriptions.Item label='Captured'>
            {formatMinorUnits(payment.gateway.capturedAmountMinor, payment.currency)}
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </>
  )
}

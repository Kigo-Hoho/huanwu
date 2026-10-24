import type { CaseDetailView, OrderSide, ReturnView } from '@barter/contracts';
import { Button, Image, Input, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { AfterSalesAction, AfterSalesApi, PendingAfterSalesCommand } from '../../../features/after-sales/after-sales-api';
import type { OrderApi } from '../../../features/orders/order-api';
import { ApiClientError } from '../../../lib/api-client';
import { chooseItemImages, defaultAfterSalesApi, defaultIdentityProvider, defaultOrderApi } from '../../../lib/default-services';
import { alertRole, buttonRole, pureCustomer, sideLabel, type CustomerIdentity } from '../../orders/shared';
import { CompensationActions } from '../compensation-actions';
import { EvidenceForm } from '../evidence-form';
import { ReportForm } from '../report-form';
import { ResolutionActions } from '../resolution-actions';
import { ReturnActions } from '../return-actions';
import { TradingFreezeBanner } from '../trading-freeze-banner';

const statusLabels: Record<string, string> = {
  OPEN: '已开立', AWAITING_RESPONSE: '待回应', UNDER_REVIEW: '审核中', AWAITING_AGREEMENT: '待双方同意',
  EXECUTING: '执行中', RESOLVED: '已结案', REJECTED: '已驳回', WITHDRAWN: '已撤回',
};

export function AfterSalesDetailPage({
  api = defaultAfterSalesApi,
  orderApi = defaultOrderApi,
  caseId = Taro.getCurrentInstance().router?.params.id ?? '',
  orderVersion: orderVersionProp,
}: {
  api?: AfterSalesApi;
  orderApi?: OrderApi;
  caseId?: string;
  orderVersion?: number;
}) {
  const routerVersion = Number(Taro.getCurrentInstance().router?.params.orderVersion ?? '0');
  const [detail, setDetail] = useState<CaseDetailView | null>(null);
  const current = useRef<CaseDetailView | null>(null);
  const [returns, setReturns] = useState<ReturnView[]>([]);
  const [me, setMe] = useState<CustomerIdentity | null>(null);
  const [mySide, setMySide] = useState<OrderSide | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false);
  const [orderVersion, setOrderVersion] = useState(orderVersionProp && orderVersionProp > 0 ? orderVersionProp : routerVersion > 0 ? routerVersion : 1);
  const [responseText, setResponseText] = useState('');
  const [withdrawReason, setWithdrawReason] = useState('');
  const [evidencePreviews, setEvidencePreviews] = useState<Record<string, string>>({});
  const [checkoutText, setCheckoutText] = useState('');
  const pending = useRef<PendingAfterSalesCommand | null>(null);
  const identity = useRef<string | null>(null);
  const generation = useRef(0);
  const lifecycle = useRef(0);
  const locked = useRef(false);
  const alive = useRef(false);
  const refreshRead = useRef(0);

  const apply = (incoming: CaseDetailView, nextOrderVersion?: number) => {
    if (!alive.current || incoming.id !== caseId || (current.current && incoming.version < current.current.version)) return;
    current.current = incoming; setDetail(incoming);
    if (typeof nextOrderVersion === 'number' && nextOrderVersion > 0) setOrderVersion(nextOrderVersion);
  };

  const releasePreviews = () => {
    for (const url of Object.values(evidencePreviews)) api.releaseEvidenceUrl(url);
    setEvidencePreviews({});
  };

  const refresh = async () => {
    const read = ++refreshRead.current; ++generation.current; const life = lifecycle.current;
    releasePreviews(); setCheckoutText('');
    try {
      const actor = await api.getMe();
      const value = await api.get(caseId);
      const ret = await api.listReturns(caseId).catch(() => [] as ReturnView[]);
      const order = await orderApi.getOrder(value.orderId).catch(() => null);
      if (alive.current && life === lifecycle.current && read === refreshRead.current) {
        if (identity.current !== null && identity.current !== actor.id) {
          generation.current += 1; pending.current = null; setUnknown(false); setError(''); setResponseText(''); setWithdrawReason('');
        }
        identity.current = actor.id; setMe(actor); apply(value); setReturns(ret);
        pending.current = api.getPendingCommand(caseId, actor.id); setUnknown(!!pending.current);
        const side = order?.parties.find(p => p.userId === actor.id)?.side ?? null;
        setMySide(side);
        if (order && typeof order.version === 'number' && order.version > 0) setOrderVersion(order.version);
      }
    } catch {
      if (alive.current && life === lifecycle.current && read === refreshRead.current) {
        setMe(null); setError('工单刷新失败，请核对登录身份后重试。');
      }
    }
  };

  useEffect(() => {
    const unsub = api.onIdentityInvalidated(() => {
      generation.current += 1; identity.current = null; pending.current = null;
      setMe(null); setMySide(null); setUnknown(false); setResponseText(''); setWithdrawReason(''); setCheckoutText('');
      for (const url of Object.values(evidencePreviews)) api.releaseEvidenceUrl(url);
      setEvidencePreviews({});
      setError('登录身份已变化或无法核实，请刷新工单并重新确认操作。');
    });
    alive.current = true; const life = ++lifecycle.current; locked.current = false; setBusy(false);
    current.current = null; setDetail(null); setMe(null); pending.current = null; setUnknown(false);
    void api.authenticate(defaultIdentityProvider).then(() => { if (alive.current && life === lifecycle.current) return refresh(); })
      .catch(() => { if (alive.current && life === lifecycle.current) setError('登录失败，请重新进入售后。'); });
    return () => {
      unsub(); alive.current = false; generation.current += 1; lifecycle.current += 1;
      for (const url of Object.values(evidencePreviews)) api.releaseEvidenceUrl(url);
    };
  }, [api, orderApi, caseId]);

  const run = async (action: AfterSalesAction, input: unknown, resourceId = caseId, retry = false) => {
    if (locked.current || !current.current || !pureCustomer(me)) return;
    if (pending.current && !retry) return;
    locked.current = true; generation.current += 1; setBusy(true); setError(''); setCheckoutText('');
    const life = lifecycle.current; const actor = me?.id;
    const command = retry ? pending.current! : { resourceId, action }; pending.current = command;
    try {
      const result = await (retry ? api.retryOriginal(caseId, actor!) : api.runLogicalCommand(command.resourceId, command.action, input, caseId));
      if (!alive.current || life !== lifecycle.current || identity.current !== actor) return;
      if (result && typeof result === 'object' && 'case' in result) {
        const commandResult = result as { case: CaseDetailView; orderVersion: number };
        apply({ ...current.current!, ...commandResult.case, records: current.current!.records, evidence: current.current!.evidence, resolutions: current.current!.resolutions, compensation: current.current!.compensation }, commandResult.orderVersion);
      }
      pending.current = null; setUnknown(false); setResponseText(''); setWithdrawReason('');
      await refresh();
    } catch (cause) {
      if (!alive.current || life !== lifecycle.current || identity.current !== actor) return;
      if (cause instanceof ApiClientError && cause.statusCode < 500) {
        pending.current = null; setUnknown(false);
        if (cause.statusCode === 403 || cause.statusCode === 409) {
          setMe(null); await refresh(); setError('工单已更新，请核对后重新确认操作');
        } else setError('操作未获批准，请刷新工单后核对。');
      } else {
        setUnknown(true); setError('操作结果未明，请重试原操作并刷新核对。');
      }
    } finally {
      if (life === lifecycle.current) { locked.current = false; if (alive.current) setBusy(false); }
    }
  };

  const loadEvidence = async (evidenceId: string) => {
    const actor = identity.current; const life = lifecycle.current;
    try {
      const url = await api.readEvidencePreview(evidenceId);
      if (!alive.current || life !== lifecycle.current || identity.current !== actor) { api.releaseEvidenceUrl(url); return; }
      setEvidencePreviews(prev => ({ ...prev, [evidenceId]: url }));
    } catch { if (alive.current && identity.current === actor) setError('证据读取失败，请刷新核对。'); }
  };

  const customer = pureCustomer(me);
  const openActions = customer && detail && !unknown && !['RESOLVED', 'REJECTED', 'WITHDRAWN'].includes(detail.status);

  return <View style={{ padding: '16px', overflowWrap: 'anywhere' }}>
    <Text>售后工单</Text>
    <TradingFreezeBanner api={api} />
    <Button {...buttonRole} disabled={busy} onClick={() => { if (!locked.current) void refresh(); }}>刷新工单</Button>
    {error && <Text {...alertRole}>{error}</Text>}
    {unknown && customer && <Button {...buttonRole} disabled={busy} onClick={() => { if (pending.current) void run(pending.current.action, undefined, pending.current.resourceId, true); }}>重试原操作</Button>}
    {!detail ? <Text>加载工单中</Text> : <View>
      <Text>{statusLabels[detail.status] ?? detail.status}</Text>
      <Text>工单版本：{detail.version} · 方案版本：{detail.currentResolutionVersion ?? '无'}</Text>
      <Text>订单号：{detail.orderId}</Text>
      <Text>原因：{detail.reason}</Text>
      {detail.responseDeadline && <Text>回应截止：{detail.responseDeadline}</Text>}
      {detail.agreementDeadline && <Text>同意截止：{detail.agreementDeadline}</Text>}
      {detail.status === 'EXECUTING' && detail.compensation.some(c => ['UNKNOWN', 'FAILED'].includes(c.status)) && <Text {...alertRole}>资金状态未知，请刷新核对</Text>}
      <Text>记录</Text>
      {detail.records.map(r => <Text key={r.id}>{r.createdAt} · {r.actorKind}{r.side ? `/${sideLabel(r.side)}` : ''} · {r.kind} · {r.description}</Text>)}
      <Text>证据</Text>
      {detail.evidence.map(e => <View key={e.id}>
        <Text>{e.description}</Text>
        <Button {...buttonRole} disabled={busy} onClick={() => { void loadEvidence(e.id); }}>查看证据预览</Button>
        {evidencePreviews[e.id] && <Image src={evidencePreviews[e.id]!} mode='aspectFit' style={{ width: '160px', height: '120px' }} />}
      </View>)}
      {openActions && <EvidenceForm detail={detail} orderVersion={orderVersion} busy={busy} chooseImages={chooseItemImages} onAppend={async (input, files) => {
        if (locked.current || !me) return;
        locked.current = true; generation.current += 1; setBusy(true); setError('');
        const life = lifecycle.current; const actor = me.id;
        pending.current = { resourceId: caseId, action: 'appendEvidence' };
        try {
          const result = await api.appendEvidence(caseId, input, files);
          if (!alive.current || life !== lifecycle.current || identity.current !== actor) return;
          apply({ ...detail, ...result.case }, result.orderVersion);
          pending.current = null; setUnknown(false);
          await refresh();
        } catch (cause) {
          if (!alive.current || life !== lifecycle.current || identity.current !== actor) return;
          if (cause instanceof ApiClientError && cause.statusCode < 500) {
            pending.current = null; setUnknown(false);
            if (cause.statusCode === 403 || cause.statusCode === 409) { setMe(null); await refresh(); setError('工单已更新，请核对后重新确认操作'); }
            else setError('操作未获批准，请刷新工单后核对。');
          } else { setUnknown(true); setError('操作结果未明，请重试原操作并刷新核对。'); throw cause; }
        } finally { if (life === lifecycle.current) { locked.current = false; if (alive.current) setBusy(false); } }
      }} />}
      <ResolutionActions
        detail={detail}
        orderVersion={orderVersion}
        busy={busy || !customer}
        onConsent={(decision, reason) => {
          void run('consent', { expectedCaseVersion: detail.version, expectedOrderVersion: orderVersion, resolutionVersion: detail.currentResolutionVersion ?? 1, decision, ...(reason ? { reason } : {}) });
        }}
        onConfirmKeep={() => {
          void run('confirmKeep', { expectedCaseVersion: detail.version, expectedOrderVersion: orderVersion, resolutionVersion: detail.currentResolutionVersion ?? 1 });
        }}
      />
      <ReturnActions
        detail={detail}
        returns={returns}
        orderVersion={orderVersion}
        busy={busy || !customer}
        onRegister={input => { void run('registerReturn', input); }}
        onConfirm={input => { void run('confirmReturn', input); }}
      />
      <CompensationActions
        detail={detail}
        orderVersion={orderVersion}
        mySide={mySide}
        busy={busy || !customer}
        onRequest={() => {
          void run('requestCompensation', { expectedCaseVersion: detail.version, expectedOrderVersion: orderVersion, resolutionVersion: detail.currentResolutionVersion ?? 1 });
        }}
        onLoadCheckout={paymentId => {
          void api.getCheckout(caseId, paymentId).then(checkout => {
            if (!alive.current) return;
            setCheckoutText(checkout.status === 'READY' ? `模拟付款就绪 · ${checkout.params.businessNo}` : '付款参数尚未就绪');
          }).catch(() => setError('补偿付款参数读取失败，请刷新核对。'));
        }}
        onTestComplete={paymentId => {
          void run('testCompensation', { expectedCaseVersion: detail.version, expectedOrderVersion: orderVersion, resolutionVersion: detail.currentResolutionVersion ?? 1 }, paymentId);
        }}
      />
      {checkoutText && <Text>{checkoutText}</Text>}
      {openActions && detail.status === 'AWAITING_RESPONSE' && <View>
        <Input aria-label='回应说明' value={responseText} disabled={busy} onInput={e => setResponseText(e.detail.value)} />
        <Button {...buttonRole} disabled={busy || !responseText.trim()} onClick={() => {
          if (!responseText.trim()) return;
          void run('respond', { expectedCaseVersion: detail.version, expectedOrderVersion: orderVersion, description: responseText.trim() });
        }}>提交回应</Button>
      </View>}
      {openActions && !['RESOLVED', 'REJECTED', 'WITHDRAWN'].includes(detail.status) && <View>
        <Input aria-label='撤回原因' value={withdrawReason} disabled={busy} onInput={e => setWithdrawReason(e.detail.value)} />
        <Button {...buttonRole} disabled={busy || !withdrawReason.trim()} onClick={() => {
          if (!withdrawReason.trim()) return;
          void run('withdraw', { expectedCaseVersion: detail.version, expectedOrderVersion: orderVersion, reason: withdrawReason.trim() });
        }}>申请撤回售后</Button>
      </View>}
      <ReportForm
        targetType='ORDER'
        targetId={detail.orderId}
        expectedTargetVersion={orderVersion}
        visible={customer && !!detail}
        onSubmit={input => api.report(input)}
        busy={busy}
      />
    </View>}
  </View>;
}
export default AfterSalesDetailPage;

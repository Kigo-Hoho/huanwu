import { CreateItemSchema, type ItemView } from '@barter/contracts';
import { Button, Input, Label, Picker, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useMemo, useState, type ComponentProps } from 'react';

import type { IdentityCodeProvider } from '../../../features/auth/identity-code.provider';
import type { ImageUploadClient } from '../../../features/images/image-upload.client';
import {
  chooseItemImages,
  createSubmitCommandKey,
  defaultApiClient,
  defaultIdentityProvider,
  defaultImageUploadClient,
} from '../../../lib/default-services';

type CreateItem = Pick<
  ItemView,
  'title' | 'description' | 'referenceValueFen' | 'condition' | 'imageUrls' | 'wantedText'
>;

interface CreateApi {
  authenticate(identityProvider: IdentityCodeProvider): Promise<void>;
  createItem(input: CreateItem): Promise<ItemView>;
  getMyItem(itemId: string): Promise<ItemView>;
  updateItem(itemId: string, input: CreateItem): Promise<ItemView>;
  submitItem(itemId: string, idempotencyKey: string): Promise<ItemView>;
}

export interface CreateItemDependencies {
  api: CreateApi;
  imageUpload: Pick<ImageUploadClient, 'upload'>;
  identityProvider: IdentityCodeProvider;
  chooseImages(): Promise<string[]>;
  createIdempotencyKey(): string;
}

const defaultDependencies: CreateItemDependencies = {
  api: defaultApiClient,
  imageUpload: defaultImageUploadClient,
  identityProvider: defaultIdentityProvider,
  chooseImages: chooseItemImages,
  createIdempotencyKey: createSubmitCommandKey,
};

const conditions = ['LIKE_NEW', 'GOOD', 'FAIR'] as const;
const conditionLabels = ['近乎全新', '状态良好', '有明显使用痕迹'];
const buttonRole = { role: 'button' } as unknown as ComponentProps<typeof Button>;
const alertRole = { role: 'alert' } as unknown as ComponentProps<typeof Text>;

export function yuanToFen(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [yuan, decimal = ''] = normalized.split('.');
  const fen = BigInt(yuan) * 100n + BigInt(decimal.padEnd(2, '0'));
  if (fen > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(fen);
}

function fenToYuanInput(fen: number): string {
  const whole = Math.floor(fen / 100);
  const decimal = fen % 100;
  return decimal === 0 ? String(whole) : `${whole}.${String(decimal).padStart(2, '0')}`;
}

function currentRouteItemId(): string {
  try {
    return Taro.getCurrentInstance?.().router?.params.id ?? '';
  } catch {
    return '';
  }
}

export function CreateItemPage({
  dependencies = defaultDependencies,
  itemId,
}: {
  dependencies?: CreateItemDependencies;
  itemId?: string;
}) {
  const [editingItemId] = useState(() => itemId ?? currentRouteItemId());
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [yuan, setYuan] = useState('');
  const [conditionIndex, setConditionIndex] = useState(1);
  const [wantedText, setWantedText] = useState('');
  const [existingImageUrls, setExistingImageUrls] = useState<string[]>([]);
  const [localImages, setLocalImages] = useState<string[]>([]);
  const [loadingItem, setLoadingItem] = useState(Boolean(editingItemId));
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const candidate = useMemo(() => {
    const referenceValueFen = yuanToFen(yuan);
    if (referenceValueFen === null) return null;
    const validation = CreateItemSchema.safeParse({
      title,
      description,
      referenceValueFen,
      condition: conditions[conditionIndex],
      imageUrls: [
        ...existingImageUrls,
        ...localImages.map((_, index) => `https://validation.invalid/${index}.jpg`),
      ],
      wantedText,
    });
    return validation.success ? validation.data : null;
  }, [conditionIndex, description, existingImageUrls, localImages, title, wantedText, yuan]);

  useEffect(() => {
    if (!editingItemId) return;
    let active = true;
    void (async () => {
      try {
        await dependencies.api.authenticate(dependencies.identityProvider);
        const item = await dependencies.api.getMyItem(editingItemId);
        if (!active) return;
        if (item.status !== 'REJECTED' && item.status !== 'DRAFT') {
          throw new Error('当前物品不可编辑。');
        }
        setTitle(item.title);
        setDescription(item.description);
        setYuan(fenToYuanInput(item.referenceValueFen));
        setConditionIndex(Math.max(0, conditions.indexOf(item.condition)));
        setWantedText(item.wantedText);
        setExistingImageUrls(item.imageUrls);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '加载物品失败。');
      } finally {
        if (active) setLoadingItem(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [dependencies.api, dependencies.identityProvider, editingItemId]);

  async function selectImages(): Promise<void> {
    try {
      const paths = await dependencies.chooseImages();
      setLocalImages(paths.slice(0, Math.max(0, 9 - existingImageUrls.length)));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '选择图片失败。');
    }
  }

  async function submit(): Promise<void> {
    if (!candidate || busy || loadingItem) return;
    setBusy(true);
    setError('');
    try {
      await dependencies.api.authenticate(dependencies.identityProvider);
      const uploadedImageUrls = await Promise.all(
        localImages.map((localPath) => dependencies.imageUpload.upload(localPath)),
      );
      const imageUrls = [...existingImageUrls, ...uploadedImageUrls];
      const payload = CreateItemSchema.parse({ ...candidate, imageUrls });
      const draft = editingItemId
        ? await dependencies.api.updateItem(editingItemId, payload)
        : await dependencies.api.createItem(payload);
      const item = await dependencies.api.submitItem(
        draft.id,
        dependencies.createIdempotencyKey(),
      );
      setSubmitted(item.status === 'PENDING_REVIEW');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提交失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  if (submitted) {
    return (
      <View>
        <Text>等待审核</Text>
      </View>
    );
  }

  return (
    <View>
      <Label>
        <Text>物品名称</Text>
        <Input
          aria-label='物品名称'
          value={title}
          maxlength={60}
          onInput={(event) => setTitle(event.detail.value)}
        />
      </Label>
      <Label>
        <Text>物品描述</Text>
        <Input
          aria-label='物品描述'
          value={description}
          maxlength={2000}
          onInput={(event) => setDescription(event.detail.value)}
        />
      </Label>
      <Label>
        <Text>参考价值（元）</Text>
        <Input
          aria-label='参考价值（元）'
          type='digit'
          value={yuan}
          onInput={(event) => setYuan(event.detail.value)}
        />
      </Label>
      <Picker
        mode='selector'
        range={conditionLabels}
        value={conditionIndex}
        onChange={(event) => setConditionIndex(Number(event.detail.value))}
      >
        <View>成色：{conditionLabels[conditionIndex]}</View>
      </Picker>
      <Label>
        <Text>想换什么</Text>
        <Input
          aria-label='想换什么'
          value={wantedText}
          maxlength={200}
          onInput={(event) => setWantedText(event.detail.value)}
        />
      </Label>
      <Button {...buttonRole} onClick={selectImages}>选择图片</Button>
      <Text>已选择 {existingImageUrls.length + localImages.length} / 9 张</Text>
      {error ? <Text {...alertRole}>{error}</Text> : null}
      <Button
        {...({
          role: 'button',
          'aria-disabled': !candidate || busy || loadingItem,
        } as unknown as ComponentProps<typeof Button>)}
        disabled={!candidate || busy || loadingItem}
        loading={busy}
        onClick={submit}
      >
        保存并提交审核
      </Button>
    </View>
  );
}

export default CreateItemPage;

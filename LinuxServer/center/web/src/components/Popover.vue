<!--
  R158.36 (2026-10-03) — Generic mini-popover for AD object write
  actions. Used by UserPropertyPanel / GroupPropertyPanel to host
  inline forms (重置密码 / 设置经理 / 编辑属性 / 添加成员) anchored
  to a trigger button.

  Replaces the prior 9 full-screen modal components
  (UserPasswordResetModal / UserAttributesModal / ...). Unlike
  position:fixed;inset:0 modals, popovers don't dim the rest of the
  page — the operator sees context (the object they selected in the
  middle pane) while editing in the right pane.

  Usage:
    <button ref="triggerRef" @click="open">重置密码</button>
    <Popover :anchor="triggerRef" :open="open" title="重置密码"
             @close="open = false" @submit="onSubmit">
      <input v-model="newPassword" type="password" />
    </Popover>
-->
<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="popEl"
      class="popover"
      :style="{ left: posX + 'px', top: posY + 'px' }"
      @keydown.esc.stop="$emit('close')"
    >
      <header class="pop-head" @mousedown="onHeadMouseDown" style="cursor: move;">
        <strong>{{ title }}</strong>
        <button class="x" @click="$emit('close')" :title="`关闭 (Esc)`">×</button>
      </header>
      <div class="pop-body">
        <slot />
      </div>
      <footer v-if="$slots.actions" class="pop-foot">
        <slot name="actions" />
      </footer>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch, onBeforeUnmount, onMounted, nextTick } from 'vue';

// R158.60.18 — drag support: mousedown on .pop-head, follow pointer,
// update posX/posY live so the popover is repositionable. 触发条件:
// drag 不进 anchor 模式 (recompute 在 resize/scroll 重算, drag 期间
// 排除这两个 listener, 否则会跟 user 抢位置).
let dragOffX = 0;
let dragOffY = 0;
let dragging = false;
function onHeadMouseDown(e) {
  if (e.button !== 0) return;
  dragging = true;
  dragOffX = e.clientX - posX.value;
  dragOffY = e.clientY - posY.value;
  e.preventDefault();
  // drag 期间 detach scroll/resize 监听器, 避免 recompute 抢位置
  window.removeEventListener('resize', recompute);
  window.removeEventListener('scroll', recompute, true);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}
function onDragMove(e) {
  if (!dragging) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  posX.value = Math.max(8, Math.min(e.clientX - dragOffX, vw - 100));
  posY.value = Math.max(8, Math.min(e.clientY - dragOffY, vh - 60));
}
function onDragEnd() {
  dragging = false;
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  // drag 完保留 user 拖到的位置 (不 recompute, 避免 anchor 把 user
  // 拖的位置覆盖). 重新 attach scroll/resize 监听器, 但已经
  // displacement 好的 popover 在 scroll/resize 触发 recompute 时
  // 会被重置回 anchor — 接受这个 trade-off (open 期间窗口 resize 是
  // 边缘情况, scroll 也不会真触发因为 popover fixed; 唯一会 reset
  // 的是 resize, 那本来就想重新对齐).
  if (props.open) {
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
  }
}

const props = defineProps({
  anchor: { type: [Object, HTMLElement], default: null },
  // Anchor reference: when truthy, the popover anchors to its
  // bounding rect. When falsy, we fall back to fixed center.
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  width: { type: Number, default: 520 },
  height: { type: Number, default: 540 },
  // 'center' = float at the middle of the viewport (R158.60.21 default
  // — operator "弹出窗口中显示的不明显, 也没有边框, 按道理弹出框应该需要
  // 在屏幕中间比较好"). 'right' = extend to the right of anchor, 'below' =
  // drop below, 'above' = float above. Anchor-less callers without
  // explicit placement also land centered.
  placement: { type: String, default: 'center' }
});

const emit = defineEmits(['close', 'submit']);
const popEl = ref(null);
const posX = ref(0);
const posY = ref(0);

function recompute() {
  // Caller may pass either a raw HTMLElement OR a Vue template ref
  // object ({ value: HTMLElement }) — unwrap once before checking.
  let a = props.anchor;
  if (a && 'value' in a && a.value === null) a = null;
  const el = a && 'value' in a ? a.value : a;
  if (!el || !el.getBoundingClientRect) {
    posX.value = Math.max(20, (window.innerWidth - props.width) / 2);
    posY.value = Math.max(20, (window.innerHeight - props.height) / 2);
    return;
  }
  a = el;
  const r = a.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x, y;
  if (props.placement === 'below') {
    x = r.left;
    y = r.bottom + 4;
  } else if (props.placement === 'above') {
    x = r.left;
    y = Math.max(8, r.top - props.height - 4);
  } else if (props.placement === 'right') {
    x = r.right + 4;
    y = r.top;
  } else {
    // 'center' (R158.60.21 default) — float at the middle of the
    // viewport, ignoring the anchor's bounding rect. Operator feedback:
    // "弹出框应该需要在屏幕中间比较好" — anchor-relative popovers were
    // hard to spot (small, off to the side). Center-placed is the
    // common case for short-lived forms (重置密码 / 编辑属性 / etc.).
    x = (vw - props.width) / 2;
    y = (vh - props.height) / 2;
  }
  // Clamp so the popover stays on-screen.
  x = Math.max(8, Math.min(x, vw - props.width - 8));
  y = Math.max(8, Math.min(y, vh - props.height - 8));
  posX.value = x;
  posY.value = y;
}

// Outside-click closes the popover.
function onDocClick(e) {
  if (!props.open) return;
  if (popEl.value && popEl.value.contains(e.target)) return;
  const a = props.anchor;
  const el = a && 'value' in a ? a.value : a;
  if (el && el.contains && el.contains(e.target)) return;
  emit('close');
}

// R158.60.18 — UserPropertyPanel 拆 6 个 Popover 后, 子组件 mount 时
// `open` prop 已经是 true (父层 v-if 同步切换). 旧版 watch lazy, 不触发
// 首屏 recompute, 导致 posX/posY 停留初始值 0, 弹窗跑左上角. 改 immediate
// + 增 onMounted 兜底 (caller 可能传 HTMLElement ref 还没 attached).
onMounted(async () => {
  if (props.open) {
    await nextTick();
    recompute();
  }
});

watch(() => props.open, async (v) => {
  if (v) {
    await nextTick();
    recompute();
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
  } else {
    document.removeEventListener('mousedown', onDocClick);
    window.removeEventListener('resize', recompute);
    window.removeEventListener('scroll', recompute, true);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('resize', recompute);
  window.removeEventListener('scroll', recompute, true);
});
</script>

<style scoped>
.popover {
  position: fixed;
  width: 520px;
  max-height: 540px;
  background: var(--panel);
  /* R158.60.21 — operator "弹出窗口中显示的不明显, 也没有边框". 1px
     浅灰边在白/深 theme 下都容易被忽视, 改 2px 主体色边 + 强 shadow
     让 popover 在任何背景上都有清晰视觉边界. */
  border: 2px solid var(--text);
  border-radius: 8px;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.4),
    0 16px 48px rgba(0, 0, 0, 0.55),
    0 4px 12px rgba(0, 0, 0, 0.35);
  z-index: 200;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pop-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 2px solid var(--text);
  background: var(--input-bg);
  font-size: 14px;
  font-weight: 600;
}
.pop-head .x {
  background: transparent; border: 0; cursor: pointer;
  font-size: 18px; line-height: 1; color: var(--text-muted);
  padding: 0 4px;
}
.pop-head .x:hover { color: var(--text); }
.pop-body {
  flex: 1 1 auto; overflow: auto;
  padding: 12px;
}
.pop-foot {
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--input-bg);
  display: flex; gap: 8px; justify-content: flex-end;
}
</style>

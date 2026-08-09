<template>
  <div v-if="visible" class="modal-bg" @click.self="$emit('close')">
    <div class="modal">
      <header>
        <h3>DDL 预览: {{ schemaName }}</h3>
        <button data-test="close" @click="$emit('close')">×</button>
      </header>
      <section>
        <p class="warning">未签名包 — install 前请审查以下 DDL。</p>
        <div v-for="f in files" :key="f.filename" class="file-block">
          <h4>{{ f.path }}</h4>
          <pre><code>{{ f.content }}</code></pre>
        </div>
      </section>
      <footer>
        <button @click="$emit('close')">关闭</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
defineProps({ visible: Boolean, schemaName: String, files: Array });
defineEmits(['close']);
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; }
.modal { background: var(--panel); padding: 1.5em; border-radius: 6px; max-width: 80vw; max-height: 80vh; overflow: auto; }
.warning { color: #b00; }
pre { background: #0b1220; padding: 0.5em; overflow: auto; }
header { display: flex; justify-content: space-between; align-items: center; }
header h3 { margin: 0; }
header button { background: transparent; border: none; font-size: 1.4em; cursor: pointer; color: var(--text); }
footer { display: flex; justify-content: flex-end; margin-top: 1em; }
.file-block { margin-bottom: 1em; }
.file-block h4 { margin: 0 0 0.25em; font-size: 0.9em; color: var(--muted); }
</style>

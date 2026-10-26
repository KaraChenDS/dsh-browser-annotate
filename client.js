/**
 * Browser half of the in-app-browser annotator — a Codex-style annotation UI.
 *
 * Three surfaces:
 *
 * 1. In-page layer (installed into the browsed page through the webview's
 *    executeJavaScript): numbered badges pinned to annotated elements, a
 *    white comment popover (add and edit modes), and a persistent dark
 *    toolbar with count, page screenshot, badge visibility, clear, send and
 *    close — draggable, re-injected after navigations while the mode lives.
 * 2. Composer toolbar: the 标注 toggle with a live count badge.
 * 3. Composer dock card: one card per annotation with an element thumbnail
 *    (captured from the page and cropped to the element rect), the tag chip,
 *    edit and delete verbs, the comment, and an "N 条注释" pill.
 *
 * The annotation block stays synced into the draft automatically, so any send
 * carries it; the toolbar 发送 syncs and submits through the composer's own
 * action. Page-to-host traffic (selections, edits, removals, toolbar commands)
 * rides one polled queue; every failure path degrades to plain pass-through.
 */
window.__ModuleLoader__.load({
	id: 'dsh-browser-annotate',
	factory: (require) => {
		const React = require('react');
		const { createElement: h, useSyncExternalStore, useEffect } = React;

		/** Locale namespace owned by this plugin. */
		const NS = 'browserAnnotate';
		/** Stable discovery attribute the shipped Browser package puts on each guest. */
		const WEBVIEW_SELECTOR = '[data-sidebar-browser-frame="webview"]';
		/** Idle availability probe and page-channel poll cadence. */
		const WATCH_MS = 1200;
		const POLL_MS = 300;

		const zh = {
			'action': '标注',
			'action.on': '标注中',
			'action.tip': '标注右侧浏览器页面中的元素（点击选择，Esc 退出）',
			'mode.hint': '在页面中点击元素添加批注；按 Esc 退出',
			'tray.pill': '{n} 条注释',
			'tray.edit': '编辑批注',
			'tray.remove': '删除批注',
			'tray.clear': '清空',
			'file.title': '页面批注',
			'tray.synced': '发送时作为隐藏上下文带出，界面只显示注释芯片',
			'tray.nodraft': '暂无法附加到消息，批注仅显示在卡片里',
			'block.header': '【页面标注 · 共 {n} 条】请按标注修改，并逐条回应。',
			'block.page': '页面：',
			'block.element': '元素：',
			'block.selector': '选择器：',
			'block.text': '文本：',
			'block.rect': '位置：',
			'block.comment': '批注：',
			'page.bar': '批注',
			'page.barOn': '正在批注',
			'page.save': '保存',
			'page.cancel': '取消',
			'page.send': '发送',
			'page.ph': '写下批注（可留空）· Enter 保存 · Alt+Enter 换行',
			'page.tipShot': '页面截图并附到输入框',
			'page.tipEye': '隐藏 / 显示批注序号',
			'page.tipClear': '清空全部批注',
			'page.tipClose': '退出标注模式',
		};

		const en = {
			'action': 'Annotate',
			'action.on': 'Annotating',
			'action.tip': 'Annotate an element in the browser page (click to pick, Esc to exit)',
			'mode.hint': 'Click an element in the page to annotate; press Esc to exit',
			'tray.pill': '{n} annotations',
			'tray.edit': 'Edit note',
			'tray.remove': 'Remove note',
			'tray.clear': 'Clear',
			'file.title': 'Page annotations',
			'tray.synced': 'Sent as hidden context; only the chip shows in Chat',
			'tray.nodraft': 'Cannot attach to the message; notes stay in this card',
			'block.header': '[Page annotations · {n}] Please apply each note and respond to them one by one.',
			'block.page': 'Page: ',
			'block.element': 'Element: ',
			'block.selector': 'Selector: ',
			'block.text': 'Text: ',
			'block.rect': 'Rect: ',
			'block.comment': 'Note: ',
			'page.bar': 'Notes',
			'page.barOn': 'Annotating',
			'page.save': '保存',
			'page.cancel': '取消',
			'page.send': 'Send',
			'page.ph': 'Write a note (optional) · Enter saves · Alt+Enter newline',
			'page.tipShot': 'Screenshot the page into the composer',
			'page.tipEye': 'Hide / show badge numbers',
			'page.tipClear': 'Clear all annotations',
			'page.tipClose': 'Exit annotation mode',
		};

		const css = [
			'.dsha-btn{border:0;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;line-height:20px;border-radius:var(--dsw-radius-sm);display:inline-flex;align-items:center;gap:4px;padding:2px 8px;white-space:nowrap}',
			'.dsha-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.dsha-btn[data-active=true]{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}',
			'.dsha-badge{border-radius:999px;background:var(--dsw-alias-state-business-primary);color:#fff;font-size:10px;line-height:14px;min-width:14px;padding:0 4px;text-align:center}',
			'.dsha-tray{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:8px;padding:10px 12px;font-size:12px;line-height:18px;max-height:260px;overflow:auto}',
			'.dsha-cards{display:flex;flex-direction:column;gap:6px}',
			'.dsha-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);padding:7px 8px;display:flex;flex-direction:column;gap:4px;min-width:0}',
			'.dsha-cardTop{display:flex;align-items:center;gap:8px;min-width:0}',
			'.dsha-thumb{width:36px;height:36px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);object-fit:contain;background:var(--dsw-alias-bg-layer-2);flex:none;display:block}',
			'.dsha-ph{width:36px;height:36px;border-radius:8px;border:.5px dashed var(--dsw-alias-border-l2);flex:none;display:inline-block}',
			'.dsha-tag{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%;flex:none}',
			'.dsha-spacer{flex:auto;min-width:0}',
			'.dsha-mini{border:0;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:4px;border-radius:6px;line-height:0;display:inline-flex;flex:none}',
			'.dsha-mini:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.dsha-comment{color:var(--dsw-alias-label-primary);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;padding-left:2px}',
			'.dsha-foot{display:flex;align-items:center;gap:8px}',
			'.dsha-pill{display:inline-flex;align-items:center;gap:5px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.dsha-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:auto;min-width:0}',
			'.dsha-act{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;line-height:18px;padding:2px 10px}',
			'.dsha-act:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dsha-chipRow{position:relative;display:flex;padding:2px 0}',
			'.dsha-chip{display:inline-flex;align-items:center;gap:5px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;line-height:18px;padding:2px 10px}',
			'.dsha-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.dsha-pop{position:absolute;left:0;bottom:calc(100% + 6px);z-index:50;box-sizing:border-box;max-width:min(520px,80vw);max-height:300px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 28px rgba(0,0,0,.22);color:var(--dsw-alias-label-primary);font-size:12px;line-height:19px;padding:9px 11px}',
		].join('\n');

		/**
		 * The full in-page annotator: picking, badges, popover, toolbar.
		 * Self-contained (no closure over this module); stringified at call time.
		 * @param L - localized page-side strings.
		 * @param picking - whether to arm the picker immediately.
		 * @returns 'on'.
		 */
		function installAnnotator(L, picking) {
			var W = window;
			var d = document;
			if (W.__dshAnn && W.__dshAnn.pickOn) {
				if (picking) return W.__dshAnn.pickOn();
				return 'on';
			}
			var ann = {
				on: false,
				hidden: false,
				list: [],
				added: [],
				updates: [],
				removes: [],
				cmds: [],
				seq: 0,
			};
			W.__dshAnn = ann;
			function uid() {
				ann.seq += 1;
				return 'a' + ann.seq + '-' + Math.floor(Math.random() * 1e7).toString(36);
			}
			ann.poll = function () {
				var r = JSON.stringify({
					added: ann.added,
					updates: ann.updates,
					removes: ann.removes,
					cmds: ann.cmds,
					picking: ann.on,
					count: ann.list.length,
				});
				ann.added = [];
				ann.updates = [];
				ann.removes = [];
				ann.cmds = [];
				return r;
			};
			function el(tag, style, html) {
				var n = d.createElement(tag);
				if (style) n.setAttribute('style', style);
				if (html !== undefined) n.innerHTML = html;
				return n;
			}
			var SVG = 'width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
			var hl = el('div', 'position:fixed;z-index:2147483645;pointer-events:none;display:none;top:0;left:0;box-sizing:border-box;border:2px solid #3b82f6;background:rgba(59,130,246,.08);border-radius:4px');
			// --- comment popover (white card, Codex layout) ---
			var pop = el('div', 'position:fixed;z-index:2147483647;display:none;box-sizing:border-box;width:320px;background:#fff;color:#1f2328;border:1px solid #e4e6ea;border-radius:14px;box-shadow:0 12px 36px rgba(0,0,0,.18);padding:12px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif');
			var row1 = el('div', 'display:flex;align-items:flex-start;gap:8px;color:#8b919c');
			var iconSliders = el('span', 'flex:none;padding-top:10px;line-height:0', '<svg ' + SVG + '><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>');
			var ta = el('textarea', 'flex:auto;box-sizing:border-box;min-height:44px;max-height:140px;resize:none;border:0;outline:none;font:inherit;color:#1f2328;background:transparent');
			ta.placeholder = L.ph;
			row1.appendChild(iconSliders);
			row1.appendChild(ta);
			var row2 = el('div', 'display:flex;align-items:center;gap:8px;margin-top:8px');
			var delBtn = el('button', 'border:0;background:0 0;color:#8b919c;cursor:pointer;padding:6px;border-radius:8px;line-height:0;display:none', '<svg ' + SVG + '><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>');
			var spacer = el('span', 'flex:auto');
			var cancelBtn = el('button', 'border:0;background:0 0;color:#4b5563;cursor:pointer;font:inherit;padding:6px 14px;border-radius:999px');
			cancelBtn.textContent = L.cancel;
			var okBtn = el('button', 'border:0;background:#16181d;color:#fff;cursor:pointer;font:600 13px/1 -apple-system,BlinkMacSystemFont,sans-serif;padding:9px 16px;border-radius:999px');
			okBtn.textContent = L.save;
			row2.appendChild(delBtn);
			row2.appendChild(spacer);
			row2.appendChild(cancelBtn);
			row2.appendChild(okBtn);
			pop.appendChild(row1);
			pop.appendChild(row2);
			// --- persistent bottom toolbar (dark pill) ---
			var bar = el('div', 'position:fixed;z-index:2147483646;display:none;box-sizing:border-box;align-items:center;gap:2px;left:50%;bottom:18px;transform:translateX(-50%);background:#16181d;color:#e8eaed;border-radius:14px;box-shadow:0 10px 32px rgba(0,0,0,.35);padding:6px 6px 6px 4px;font:12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none');
			var grip = el('span', 'cursor:grab;color:#6b7280;padding:6px 4px;line-height:0;display:flex;flex:none', '<svg ' + SVG + '><circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/></svg>');
			var barLabel = el('span', 'padding:0 8px;white-space:nowrap;flex:none');
			function barBtn(inner, tip) {
				var b = el('button', 'border:0;background:0 0;color:#c3c8d1;cursor:pointer;padding:7px;border-radius:9px;line-height:0;display:flex;flex:none', '<svg ' + SVG + '>' + inner + '</svg>');
				b.title = tip;
				return b;
			}
			var shotBtn = barBtn('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>', L.tipShot);
			var eyeBtn = barBtn('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>', L.tipEye);
			var trashBtn = barBtn('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', L.tipClear);
			var sendBtn = el('button', 'border:0;background:#3b82f6;color:#fff;cursor:pointer;font:600 12px/1 -apple-system,BlinkMacSystemFont,sans-serif;padding:8px 14px;border-radius:10px;margin-left:4px;flex:none');
			sendBtn.textContent = L.send;
			var closeBtn = barBtn('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', L.tipClose);
			[grip, barLabel, shotBtn, eyeBtn, trashBtn, sendBtn, closeBtn].forEach(function (n) {
				bar.appendChild(n);
			});
			var host = d.documentElement || d.body;
			host.appendChild(hl);
			host.appendChild(pop);
			host.appendChild(bar);
			// --- badges ---
			function badgeFor(it) {
				if (!it.badge) {
					it.badge = el('div', 'position:fixed;z-index:2147483644;min-width:22px;height:22px;box-sizing:border-box;border-radius:999px;background:#3b82f6;color:#fff;font:600 12px/20px -apple-system,sans-serif;text-align:center;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.3);display:none;padding:0 4px');
					host.appendChild(it.badge);
				}
				return it.badge;
			}
			function liveNode(it) {
				if (it.node && it.node.isConnected) return it.node;
				var found = null;
				try {
					found = d.querySelector(it.desc.selector);
				} catch (e) {}
				if (found) it.node = found;
				return found;
			}
			function reposition() {
				for (var i = 0; i < ann.list.length; i += 1) {
					var it = ann.list[i];
					if (!it.badge) continue;
					var node = liveNode(it);
					if (!node || ann.hidden) {
						it.badge.style.display = 'none';
						continue;
					}
					var r = node.getBoundingClientRect();
					if (r.width === 0 && r.height === 0) {
						it.badge.style.display = 'none';
						continue;
					}
					it.badge.style.display = 'block';
					it.badge.style.left = Math.max(0, Math.min(W.innerWidth - 26, r.right - 12)) + 'px';
					it.badge.style.top = Math.max(0, r.top - 11) + 'px';
				}
			}
			function renumber() {
				for (var i = 0; i < ann.list.length; i += 1) {
					var it = ann.list[i];
					it.num = i + 1;
					badgeFor(it).textContent = String(it.num);
				}
				reposition();
			}
			function refresh() {
				var n = ann.list.length;
				barLabel.textContent = ann.on ? L.barOn : L.bar;
				if (n > 0) barLabel.textContent += ' · ' + n;
				bar.style.display = ann.on || n > 0 ? 'flex' : 'none';
				reposition();
			}
			// --- describe ---
			function describe(node) {
				var tag = node.tagName.toLowerCase();
				var id = node.id ? '#' + node.id : '';
				var cls = '';
				if (typeof node.className === 'string' && node.className.trim() !== '') {
					cls = node.className
						.trim()
						.split(/\s+/)
						.filter(function (c) {
							return c !== '';
						})
						.slice(0, 2)
						.map(function (c) {
							return '.' + c;
						})
						.join('');
				}
				var text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
				if (text === '' && typeof node.value === 'string') text = node.value.trim();
				text = text.slice(0, 140);
				var path = [];
				var n = node;
				for (var i = 0; n && n.nodeType === 1 && i < 5; i += 1) {
					var seg = n.tagName.toLowerCase();
					if (n.id) {
						seg = '#' + n.id;
						path.unshift(seg);
						break;
					}
					var p = n.parentElement;
					if (p) {
						var count = 0;
						var index = 1;
						var c = p.firstElementChild;
						while (c) {
							if (c.tagName === n.tagName) {
								count += 1;
								if (c === n) index = count;
							}
							c = c.nextElementSibling;
						}
						if (count > 1) seg += ':nth-of-type(' + index + ')';
					}
					path.unshift(seg);
					n = p;
				}
				var r = node.getBoundingClientRect();
				return {
					tag: tag + id + cls,
					selector: path.join(' > '),
					text: text,
					rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
				};
			}
			// --- popover ---
			var popTarget = null;
			var popItem = null;
			function openPop(node, item) {
				popTarget = node;
				popItem = item || null;
				ta.value = popItem ? popItem.comment : '';
				delBtn.style.display = popItem ? 'block' : 'none';
				pop.style.display = 'block';
				var r = node.getBoundingClientRect();
				var ph = pop.offsetHeight || 110;
				var left = Math.max(8, Math.min(W.innerWidth - 328, r.left));
				var top = r.bottom + 10 + ph > W.innerHeight ? Math.max(8, r.top - ph - 10) : r.bottom + 10;
				pop.style.left = left + 'px';
				pop.style.top = top + 'px';
				try {
					ta.focus();
				} catch (e) {}
			}
			function closePop() {
				pop.style.display = 'none';
				popTarget = null;
				popItem = null;
			}
			function savePop() {
				var comment = ta.value.trim();
				if (popItem) {
					popItem.comment = comment;
					ann.updates.push({ id: popItem.id, comment: comment });
				} else if (popTarget) {
					var it = { id: uid(), node: popTarget, desc: describe(popTarget), comment: comment };
					ann.list.push(it);
					ann.added.push({ id: it.id, desc: it.desc, comment: comment });
				}
				closePop();
				renumber();
				refresh();
			}
			function removeLocal(id, notify) {
				for (var i = 0; i < ann.list.length; i += 1) {
					if (ann.list[i].id === id) {
						var it = ann.list.splice(i, 1)[0];
						if (it.badge && it.badge.parentNode) it.badge.parentNode.removeChild(it.badge);
						if (notify) ann.removes.push(id);
						return;
					}
				}
			}
			okBtn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				savePop();
			});
			cancelBtn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				closePop();
			});
			delBtn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				if (popItem) removeLocal(popItem.id, true);
				closePop();
				renumber();
				refresh();
			});
			ta.addEventListener('keydown', function (e) {
				if (e.key === 'Enter') {
					// IME composition: Enter confirms the candidate word, never saves.
					if (e.isComposing || e.keyCode === 229) {
						e.stopPropagation();
						return;
					}
					e.preventDefault();
					e.stopPropagation();
					if (e.altKey) {
						var s = ta.selectionStart;
						ta.value = ta.value.slice(0, s) + '\n' + ta.value.slice(ta.selectionEnd);
						ta.selectionStart = ta.selectionEnd = s + 1;
						return;
					}
					savePop();
					return;
				}
				e.stopPropagation();
			});
			// --- picking ---
			var target = null;
			function inOwn(node) {
				return (
					node === pop ||
					node === bar ||
					node === hl ||
					(pop.contains && pop.contains(node)) ||
					(bar.contains && bar.contains(node))
				);
			}
			function onMove(e) {
				if (!ann.on || inOwn(e.target)) return;
				var t = e.target;
				if (!t || t === d.documentElement || t === d.body) {
					hl.style.display = 'none';
					return;
				}
				target = t;
				var r = t.getBoundingClientRect();
				hl.style.display = 'block';
				hl.style.left = r.left + 'px';
				hl.style.top = r.top + 'px';
				hl.style.width = r.width + 'px';
				hl.style.height = r.height + 'px';
			}
			function onDown(e) {
				if (!ann.on || inOwn(e.target)) return;
				e.preventDefault();
				e.stopPropagation();
			}
			function onClick(e) {
				if (!ann.on || inOwn(e.target)) return;
				e.preventDefault();
				e.stopPropagation();
				if (pop.style.display === 'block') return;
				if (target) openPop(target, null);
			}
			function onKey(e) {
				if (e.key === 'Escape') {
					if (pop.style.display === 'block') {
						e.preventDefault();
						e.stopPropagation();
						closePop();
					} else if (ann.on) {
						e.preventDefault();
						e.stopPropagation();
						ann.pickOff();
						ann.cmds.push('exit');
					}
				}
			}
			function addPick() {
				d.addEventListener('mousemove', onMove, true);
				d.addEventListener('mousedown', onDown, true);
				d.addEventListener('click', onClick, true);
				d.addEventListener('keydown', onKey, true);
			}
			function removePick() {
				d.removeEventListener('mousemove', onMove, true);
				d.removeEventListener('mousedown', onDown, true);
				d.removeEventListener('click', onClick, true);
				d.removeEventListener('keydown', onKey, true);
				hl.style.display = 'none';
			}
			// --- toolbar buttons ---
			shotBtn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				ann.cmds.push('shot');
			});
			eyeBtn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				ann.hidden = !ann.hidden;
				reposition();
			});
			trashBtn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				ann.clearPage();
				ann.cmds.push('clear');
			});
			sendBtn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				ann.cmds.push('send');
			});
			closeBtn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				ann.pickOff();
				ann.cmds.push('exit');
			});
			// --- toolbar dragging ---
			(function () {
				var drag = false;
				var sx = 0;
				var sy = 0;
				var ox = 0;
				var oy = 0;
				grip.addEventListener('pointerdown', function (e) {
					drag = true;
					sx = e.clientX;
					sy = e.clientY;
					var r = bar.getBoundingClientRect();
					ox = r.left;
					oy = r.top;
					bar.style.transform = 'none';
					try {
						grip.setPointerCapture(e.pointerId);
					} catch (t) {}
					e.preventDefault();
				});
				grip.addEventListener('pointermove', function (e) {
					if (!drag) return;
					var x = Math.max(4, Math.min(W.innerWidth - bar.offsetWidth - 4, ox + e.clientX - sx));
					var y = Math.max(4, Math.min(W.innerHeight - bar.offsetHeight - 4, oy + e.clientY - sy));
					bar.style.left = x + 'px';
					bar.style.top = y + 'px';
					bar.style.bottom = 'auto';
				});
				grip.addEventListener('pointerup', function () {
					drag = false;
				});
			})();
			// --- reposition on scroll/resize ---
			var raf = 0;
			function onScroll() {
				if (raf) return;
				raf = W.requestAnimationFrame(function () {
					raf = 0;
					reposition();
				});
			}
			d.addEventListener('scroll', onScroll, true);
			W.addEventListener('resize', onScroll);
			// --- public API used by the host ---
			ann.pickOn = function () {
				if (!ann.on) {
					addPick();
					ann.on = true;
				}
				refresh();
				return 'on';
			};
			ann.pickOff = function () {
				ann.on = false;
				removePick();
				closePop();
				refresh();
				return 'off';
			};
			ann.edit = function (id) {
				for (var i = 0; i < ann.list.length; i += 1) {
					if (ann.list[i].id === id) {
						var it = ann.list[i];
						var node = liveNode(it);
						if (!node) return 'gone';
						openPop(node, it);
						return 'ok';
					}
				}
				return 'gone';
			};
			ann.untag = function (id) {
				removeLocal(id, false);
				renumber();
				refresh();
				return 'ok';
			};
			ann.clearPage = function () {
				var ids = ann.list.map(function (it) {
					return it.id;
				});
				for (var i = 0; i < ids.length; i += 1) removeLocal(ids[i], false);
				renumber();
				refresh();
				return 'ok';
			};
			ann.stopAll = function () {
				ann.pickOff();
				ann.clearPage();
				[hl, pop, bar].forEach(function (n) {
					if (n.parentNode) n.parentNode.removeChild(n);
				});
				d.removeEventListener('scroll', onScroll, true);
				W.removeEventListener('resize', onScroll);
				W.__dshAnn = null;
				return 'off';
			};
			if (picking) ann.pickOn();
			else refresh();
			return 'on';
		}

		/** Script builders — the page API surface the host drives. */
		function onScript(labels, picking) {
			return (
				'(function(){var L=' +
				JSON.stringify({
					ph: labels.ph,
					save: labels.save,
					cancel: labels.cancel,
					send: labels.send,
					bar: labels.bar,
					barOn: labels.barOn,
					tipShot: labels.tipShot,
					tipEye: labels.tipEye,
					tipClear: labels.tipClear,
					tipClose: labels.tipClose,
				}) +
				';' +
				installAnnotator.toString() +
				';return installAnnotator(L,' +
				(picking ? 'true' : 'false') +
				')})()'
			);
		}
		const PICK_OFF = '(function(){var a=window.__dshAnn;return a?a.pickOff():"off"})()';
		const STOP_ALL = '(function(){var a=window.__dshAnn;return a?a.stopAll():"off"})()';
		const POLL_SCRIPT = '(function(){var a=window.__dshAnn;return a?a.poll():null})()';
		const VIEWPORT_SCRIPT = 'JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio||1})';
		function editScript(id) {
			return '(function(){var a=window.__dshAnn;return a?a.edit(' + JSON.stringify(id) + '):"gone"})()';
		}
		function untagScript(id) {
			return '(function(){var a=window.__dshAnn;return a?a.untag(' + JSON.stringify(id) + '):"gone"})()';
		}
		const CLEAR_PAGE = '(function(){var a=window.__dshAnn;return a?a.clearPage():"off"})()';

		/** Read a webview accessor without throwing when the guest is gone. */
		function safeCall(el, name) {
			try {
				const value = typeof el[name] === 'function' ? el[name]() : el[name];
				return typeof value === 'string' ? value : '';
			} catch {
				return '';
			}
		}

		/** Normalize whatever capturePage resolved into a PNG Blob, if possible. */
		async function captureBlob(webview) {
			const raw = await webview.capturePage();
			if (raw instanceof Blob) return raw;
			if (raw && typeof raw.toDataURL === 'function') {
				const url = raw.toDataURL();
				if (typeof url === 'string' && url.startsWith('data:')) return await (await fetch(url)).blob();
			}
			if (raw && typeof raw.getPNG === 'function') return new Blob([raw.getPNG()], { type: 'image/png' });
			if (raw instanceof Uint8Array || (raw && raw.buffer instanceof ArrayBuffer)) return new Blob([raw], { type: 'image/png' });
			return null;
		}

		/** Shared controller behind the button and the dock. */
		class AnnotateController {
			state = { available: false, mode: false, items: [] };
			listeners = new Set();
			watchers = 0;
			watchTimer = null;
			pollTimer = null;
			webview = null;
			labels = {};
			t = null;
			composer = null;
			/** Draft helpers installed by apply: (sessionId, File) => draft ids, and release. */
			attachDraft = null;
			releaseDraft = null;


			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			};

			getSnapshot = () => this.state;

			publish(patch) {
				this.state = { ...this.state, ...patch };
				for (const listener of this.listeners) listener();
			}

			bindComposer(binding) {
				this.composer = binding;
			}

			findWebview() {
				let elements;
				try {
					elements = document.querySelectorAll(WEBVIEW_SELECTOR);
				} catch {
					return null;
				}
				for (const el of elements) {
					if (el.tagName !== 'WEBVIEW' || typeof el.executeJavaScript !== 'function') continue;
					let rect;
					try {
						rect = el.getBoundingClientRect();
					} catch {
						continue;
					}
					if (rect.width > 40 && rect.height > 40) return el;
				}
				return null;
			}

			startWatch() {
				this.watchers += 1;
				if (this.watchTimer !== null) return;
				this.watchTimer = setInterval(() => this.idleTick(), WATCH_MS);
				this.idleTick();
			}

			stopWatch() {
				this.watchers = Math.max(0, this.watchers - 1);
				if (this.watchers === 0 && this.watchTimer !== null) {
					clearInterval(this.watchTimer);
					this.watchTimer = null;
				}
			}

			idleTick() {
				const webview = this.findWebview();
				if (webview === null) {
					if (this.webview !== null || this.pollTimer !== null || this.state.mode) this.teardownPage();
					if (this.state.available) this.publish({ available: false });
					return;
				}
				if (this.webview !== null && this.webview !== webview) this.teardownPage();
				if (!this.state.available) this.publish({ available: true });
			}

			toggleMode() {
				return this.state.mode ? this.stopPicking() : this.startMode();
			}

			async startMode() {
				const webview = this.findWebview();
				if (webview === null) {
					this.publish({ available: false });
					return;
				}
				this.webview = webview;
				try {
					await webview.executeJavaScript(onScript(this.labels, true), true);
				} catch {
					this.webview = null;
					return;
				}
				this.navHandler = () => {
					const current = this.webview;
					if (current === null) return;
					if (this.state.mode) current.executeJavaScript(onScript(this.labels, true), true).catch(() => {});
				};
				webview.addEventListener('did-navigate', this.navHandler);
				if (this.pollTimer === null) this.pollTimer = setInterval(() => this.pollTick(), POLL_MS);
				this.publish({ mode: true, available: true });
			}

			stopPicking() {
				const webview = this.webview;
				if (webview !== null) webview.executeJavaScript(PICK_OFF, true).catch(() => {});
				this.publish({ mode: false });
			}

			teardownPage() {
				if (this.pollTimer !== null) {
					clearInterval(this.pollTimer);
					this.pollTimer = null;
				}
				const webview = this.webview;
				this.webview = null;
				if (webview !== null) {
					try {
						if (this.navHandler !== undefined) webview.removeEventListener('did-navigate', this.navHandler);
						webview.executeJavaScript(STOP_ALL, true).catch(() => {});
					} catch {
						/* the guest owns its own cleanup */
					}
				}
				this.publish({ mode: false });
			}

			async pollTick() {
				const webview = this.webview;
				if (webview === null) return;
				let raw;
				try {
					raw = await webview.executeJavaScript(POLL_SCRIPT, true);
				} catch {
					return;
				}
				if (raw === null || raw === undefined) return;
				let message;
				try {
					message = JSON.parse(String(raw));
				} catch {
					return;
				}
				if (message === null || typeof message !== 'object') return;
				let items = this.state.items;
				if (Array.isArray(message.added) && message.added.length > 0) {
					const url = safeCall(webview, 'getURL') || webview.getAttribute('src') || '';
					const title = safeCall(webview, 'getTitle') || '';
					const added = message.added
						.filter((entry) => entry !== null && typeof entry === 'object' && entry.desc !== undefined)
						.map((entry) => ({
							id: String(entry.id),
							url,
							title,
							desc: entry.desc,
							comment: typeof entry.comment === 'string' ? entry.comment : '',
							thumb: '',
						}));
					if (added.length > 0) {
						items = items.concat(added);
						this.publish({ items });
						this.captureThumbs(added);
					}
				}
				if (Array.isArray(message.updates) && message.updates.length > 0) {
					const byId = new Map(message.updates.map((entry) => [String(entry.id), entry]));
					items = items.map((item) =>
						byId.has(item.id) ? { ...item, comment: String(byId.get(item.id).comment ?? '') } : item,
					);
					this.publish({ items });
				}
				if (Array.isArray(message.removes) && message.removes.length > 0) {
					const gone = new Set(message.removes.map(String));
					items = items.filter((item) => !gone.has(item.id));
					this.publish({ items });
				}
				if (typeof message.picking === 'boolean' && message.picking !== this.state.mode) {
					this.publish({ mode: message.picking });
				}
				if (Array.isArray(message.cmds)) {
					for (const cmd of message.cmds) this.handleCmd(String(cmd));
				}
			}

			handleCmd(cmd) {
				if (cmd === 'exit') {
					this.publish({ mode: false });
					return;
				}
				if (cmd === 'clear') {
					this.publish({ items: [] });
					return;
				}
				if (cmd === 'send') {
					this.flushAndSubmit();
					return;
				}
				if (cmd === 'shot') {
					this.screenshotToAttachment();
				}
			}

			/** Crop element thumbnails from one page capture per batch. */
			async captureThumbs(added) {
				const webview = this.webview;
				if (webview === null) return;
				try {
					const [blob, viewportRaw] = await Promise.all([
						captureBlob(webview),
						webview.executeJavaScript(VIEWPORT_SCRIPT, true),
					]);
					if (blob === null) return;
					const viewport = JSON.parse(String(viewportRaw));
					const bitmap = await createImageBitmap(blob);
					const scale = viewport.w > 0 ? bitmap.width / viewport.w : 1;
					for (const item of added) {
						const rect = item.desc.rect;
						if (!rect || rect.w <= 0 || rect.h <= 0) continue;
						const canvas = document.createElement('canvas');
						const ratio = Math.min(1, 120 / Math.max(1, rect.w * scale));
						canvas.width = Math.max(1, Math.round(rect.w * scale * ratio));
						canvas.height = Math.max(1, Math.round(rect.h * scale * ratio));
						const ctx2d = canvas.getContext('2d');
						if (ctx2d === null) return;
						ctx2d.drawImage(bitmap, rect.x * scale, rect.y * scale, rect.w * scale, rect.h * scale, 0, 0, canvas.width, canvas.height);
						const thumb = canvas.toDataURL('image/png');
						const items = this.state.items.map((entry) => (entry.id === item.id ? { ...entry, thumb } : entry));
						this.publish({ items });
					}
				} catch {
					/* thumbnails are decorative; their absence changes nothing */
				}
			}

			/** Page screenshot -> image draft -> attach to the composer draft. */
			async screenshotToAttachment() {
				const webview = this.webview;
				const composer = this.composer;
				if (webview === null || composer === null || typeof this.attachDraft !== 'function') return;
				try {
					const blob = await captureBlob(webview);
					if (blob === null) return;
					const file = new File([blob], 'browser-page.png', { type: 'image/png' });
					const ids = this.attachDraft(composer.sessionId, file);
					const id = Array.isArray(ids) ? ids[0] : undefined;
					if (typeof id === 'string') composer.addAttachments([id]);
				} catch {
					/* a failed screenshot stays invisible; the page itself is unchanged */
				}
			}

			/**
			 * The send path: queue the notes with the host mailbox (its pre-step
			 * listener admits them as a hidden context message inside the turn this
			 * submit opens), keep the composer sendable when the draft is empty,
			 * then spend.
			 */
			async flushAndSubmit() {
				const composer = this.composer;
				if (composer === null) return;
				if (this.state.items.length > 0) {
					const queued = await this.queueNotes();
					if (queued !== true) return;
					const current = typeof composer.getDraft === 'function' ? composer.getDraft().trim() : '';
					if (current === '' && typeof composer.headerLine === 'function') composer.setDraft(composer.headerLine(this.state.items.length));
				}
				composer.submit?.();
				this.spendNotes();
			}

			/**
			 * POST the notes to the host mailbox. Chat never draws them; the
			 * plugin's own chip renders the admitted message instead.
			 */
			async queueNotes() {
				const composer = this.composer;
				if (composer === null || typeof composer.sessionId !== 'string') return false;
				try {
					const response = await fetch('api/browser-annotate.inject', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ sessionId: composer.sessionId, text: this.buildBlock() }),
					});
					const result = await response.json();
					return result?.ok === true;
				} catch {
					return false;
				}
			}

			/** Notes are spent: tray empties, page badges clear, draft ownership forgotten. */
			spendNotes() {
				if (this.state.items.length > 0) this.publish({ items: [] });
				const webview = this.webview;
				if (webview !== null) webview.executeJavaScript(CLEAR_PAGE, true).catch(() => {});
			}

			editItem(id) {
				const webview = this.webview;
				if (webview === null) return;
				webview.executeJavaScript(editScript(id), true).catch(() => {});
			}

			removeItem(id) {
				this.publish({ items: this.state.items.filter((item) => item.id !== id) });
				const webview = this.webview;
				if (webview !== null) webview.executeJavaScript(untagScript(id), true).catch(() => {});
			}

			clear() {
				if (this.state.items.length === 0) return;
				this.publish({ items: [] });
				const webview = this.webview;
				if (webview !== null) webview.executeJavaScript(CLEAR_PAGE, true).catch(() => {});
			}

			/**
			 * The notes as readable text: a header line the model follows, then one
			 * block per annotation. Recorded as a context message; never shown raw.
			 */
			buildBlock() {
				const t = this.t ?? ((key) => key);
				const items = this.state.items;
				const lines = [t('block.header', { n: items.length })];
				items.forEach((item, index) => {
					lines.push(index + 1 + '. ' + (item.comment !== '' ? item.comment : item.desc.tag));
					lines.push('   元素 ' + item.desc.tag);
					if (item.desc.selector) lines.push('   选择器 ' + item.desc.selector);
					if (item.desc.text) lines.push('   文本 ' + item.desc.text);
					const rect = item.desc.rect;
					if (rect) lines.push('   位置 (' + rect.x + ',' + rect.y + ') ' + rect.w + '×' + rect.h);
					lines.push('   页面 ' + item.url + (item.title !== '' ? '（' + item.title + '）' : ''));
				});
				return lines.join('\n');
			}

			dispose() {
				this.stopWatch();
				this.teardownPage();
				this.listeners.clear();
			}
		}

		/** Consume the controller snapshot reactively. */
		function useAnnotateState(annotate) {
			return useSyncExternalStore(annotate.subscribe, annotate.getSnapshot, annotate.getSnapshot);
		}

		/** Stable selector for the composer draft through the standard input hook. */
		function selectDraft(state) {
			return state !== null && typeof state === 'object' && typeof state.draft === 'string' ? state.draft : null;
		}

		/** Inline 15px icon in the host's stroke style. */
		function icon(paths) {
			return h(
				'svg',
				{
					width: 14,
					height: 14,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 2,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
				},
				paths.map((entry, index) => h(entry.tag, { ...entry.attrs, key: index })),
			);
		}

		const PENCIL_PATHS = [
			{ tag: 'path', attrs: { d: 'M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z' } },
		];
		const TRASH_PATHS = [
			{ tag: 'polyline', attrs: { points: '3 6 5 6 21 6' } },
			{ tag: 'path', attrs: { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' } },
		];
		const CHAT_PATHS = [
			{ tag: 'path', attrs: { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' } },
		];

		/** Compact toggle in the composer tool row; visible only with a live Browser tab. */
		function AnnotateButton({ t, annotate }) {
			const state = useAnnotateState(annotate);
			useEffect(() => {
				annotate.startWatch();
				return () => annotate.stopWatch();
			}, [annotate]);
			annotate.labels = {
				ph: t('page.ph'),
				save: t('page.save'),
				cancel: t('page.cancel'),
				send: t('page.send'),
				bar: t('page.bar'),
				barOn: t('page.barOn'),
				tipShot: t('page.tipShot'),
				tipEye: t('page.tipEye'),
				tipClear: t('page.tipClear'),
				tipClose: t('page.tipClose'),
			};
			if (!state.available && !state.mode) return null;
			return h(
				'button',
				{
					type: 'button',
					className: 'dsha-btn',
					'data-active': state.mode ? 'true' : undefined,
					title: t('action.tip'),
					onClick: () => annotate.toggleMode(),
				},
				t(state.mode ? 'action.on' : 'action'),
				state.items.length > 0 ? h('span', { className: 'dsha-badge' }, String(state.items.length)) : null,
			);
		}

		/**
		 * The composer-context card: one row per annotation with the element
		 * thumbnail, edit and delete verbs, the comment, and the count pill.
		 * The notes ride into the conversation as one 批注.md attachment, never
		 * as draft text; a settled send or a dropped attachment spends them.
		 */
		function AnnotateDock({ t, annotate, sessionId, inputActions, useInput }) {
			const state = useAnnotateState(annotate);
			const draft = typeof useInput === 'function' ? useInput(selectDraft) : null;
			const canDraft = typeof draft === 'string' && inputActions !== undefined && typeof inputActions.setDraft === 'function';
			const canAttach = canDraft && typeof inputActions.addAttachments === 'function' && typeof sessionId === 'string' && sessionId !== '';
			annotate.t = t;
			if (canDraft) {
				annotate.bindComposer({
					sessionId,
					getDraft: () => draft,
					setDraft: (text) => inputActions.setDraft(text),
					submit: () => inputActions.submit(),
				headerLine: (count) => t('block.header', { n: count }),
					addAttachments: typeof inputActions.addAttachments === 'function' ? (ids) => inputActions.addAttachments(ids) : undefined,
					removeAttachment: typeof inputActions.removeAttachment === 'function' ? (id) => inputActions.removeAttachment(id) : undefined,
				});
			}

			if (state.items.length === 0 && !state.mode) return null;
			return h(
				'div',
				{ className: 'dsha-tray', role: 'note' },
				state.items.length > 0
					? h(
							'div',
							{ className: 'dsha-cards' },
							state.items.map((item) =>
								h(
									'div',
									{ className: 'dsha-card', key: item.id },
									h(
										'div',
										{ className: 'dsha-cardTop' },
										item.thumb !== ''
											? h('img', { className: 'dsha-thumb', src: item.thumb, alt: '' })
											: h('span', { className: 'dsha-ph' }),
										h('span', { className: 'dsha-tag', title: item.desc.selector }, item.desc.tag),
										h('span', { className: 'dsha-spacer' }),
										h(
											'button',
											{
												type: 'button',
												className: 'dsha-mini',
												title: t('tray.edit'),
												onClick: () => annotate.editItem(item.id),
											},
											icon(PENCIL_PATHS),
										),
										h(
											'button',
											{
												type: 'button',
												className: 'dsha-mini',
												title: t('tray.remove'),
												onClick: () => annotate.removeItem(item.id),
											},
											icon(TRASH_PATHS),
										),
									),
									item.comment !== '' || item.desc.text !== ''
										? h('div', { className: 'dsha-comment' }, item.comment !== '' ? item.comment : item.desc.text)
										: null,
								),
							),
						)
					: null,
				h(
					'div',
					{ className: 'dsha-foot' },
					state.items.length > 0
						? h('span', { className: 'dsha-pill' }, icon(CHAT_PATHS), t('tray.pill', { n: state.items.length }))
						: null,
					h('span', { className: 'dsha-hint' }, state.mode ? t('mode.hint') : canAttach ? t('tray.synced') : t('tray.nodraft')),
					state.items.length > 0
						? h('button', { type: 'button', className: 'dsha-act', onClick: () => annotate.clear() }, t('tray.clear'))
						: null,
				),
			);
		}


		/** Source kind of the hidden context message the host admits. */
		const NOTES_SOURCE = 'browser-annotate';

		/** Extract the notes text from one hidden-context user/message event, when it is ours. */
		function splicedNotesText(event) {
			if (event?.type !== 'user/message' || event.data?.source?.kind !== NOTES_SOURCE) return null;
			const content = event.data?.content;
			if (!Array.isArray(content)) return null;
			for (const block of content) {
				if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
					return block.text;
				}
			}
			return null;
		}

		/**
		 * Render the injected notes as one collapsed chip instead of the raw
		 * block: the built-in context row stays hidden, this Definition adds
		 * the visible node, and the hover card shows the full notes.
		 */
		const notesDefinition = {
			kind: 'browser-annotate-notes',
			target: 'chat',
			match: (event) => (splicedNotesText(event) !== null ? { id: 'notes-' + event.seq, role: 'start' } : null),
			start: (_context, match) => ({ seq: match.event.seq, text: splicedNotesText(match.event) ?? '' }),
			update: (context) => context.state,
			buildViewNode: (context) => {
				if (context.state === undefined || context.state.text === '') return null;
				return {
					key: context.key,
					kind: 'annotate-notes',
					id: context.id,
					target: 'chat',
					anchorSeq: context.state.seq - 0.4,
					location: context.start?.location ?? { kind: 'unresolved' },
					visibility: 'visible',
					data: { text: context.state.text },
				};
			},
		};

		/** The transcript chip: "N 条注释", full notes on hover or focus. */
		function AnnotateNotesChip({ node, t }) {
			const [open, setOpen] = React.useState(false);
			const text = node?.data?.text ?? '';
			const countMatch = text.match(/(?:共|·\s*)(\d+)|(\d+)\s*(?:条|annotations)/);
			const count = Number(countMatch?.[1] ?? countMatch?.[2] ?? '') || (text.match(/^\s*\d+\./gm) ?? []).length || 1;
			return h(
				'div',
				{
					className: 'dsha-chipRow',
					onMouseEnter: () => setOpen(true),
					onMouseLeave: () => setOpen(false),
				},
				h(
					'button',
					{
						type: 'button',
						className: 'dsha-chip',
						'aria-expanded': open ? 'true' : 'false',
						onFocus: () => setOpen(true),
						onBlur: () => setOpen(false),
						onClick: () => setOpen(!open),
					},
					icon(CHAT_PATHS),
					t('tray.pill', { n: count }),
				),
				open
					? h('div', { className: 'dsha-pop', role: 'tooltip', children: text })
					: null,
			);
		}

		const inject = ['slots', 'locale', 'sessions', 'uiConversation'];

		/**
		 * Client plugin body.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const controller = new AnnotateController();
			/** Resolve the session-scoped conversation service that owns upload drafts. */
			const conversationFor = (sessionId) => {
				try {
					const scoped = ctx.sessions?.scope(sessionId);
					const conversation = scoped?.get?.('conversation') ?? ctx.get?.('conversation');
					return conversation ?? null;
				} catch {
					return null;
				}
			};
			controller.attachDraft = (sessionId, file) => {
				const conversation = conversationFor(sessionId);
				if (conversation === null || typeof conversation.createDrafts !== 'function') return [];
				return conversation.createDrafts(sessionId, [file]).map((draft) => draft.id);
			};
			controller.releaseDraft = (sessionId, id) => {
				const conversation = conversationFor(sessionId);
				if (conversation !== null && typeof conversation.releaseDraftAttachment === 'function') {
					conversation.releaseDraftAttachment(id);
				}
			};
			// A stable handle for console debugging and automated verification.
			if (typeof window !== 'undefined') window.dshBrowserAnnotate = controller;
			ctx.uiConversation.events.register(notesDefinition);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'browser-annotate: dictionaries');
			ctx.slots.inject('conversation.chat.node', () =>
				ctx.slots.register({ name: 'conversation.chat.node', key: 'annotate-notes', locale: NS }, AnnotateNotesChip),
			);
			ctx.effect(() => {
				const tagId = 'dsh-browser-annotate/annotate.css';
				const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']');
				if (existing !== null) return () => existing.remove();
				const tag = document.createElement('style');
				tag.dataset.plugin = 'dsh-browser-annotate';
				tag.dataset.pluginCss = tagId;
				tag.textContent = css;
				document.head.appendChild(tag);
				return () => tag.remove();
			}, 'browser-annotate: styles');
			ctx.effect(() => () => controller.dispose(), 'browser-annotate: controller');
			// While notes exist, a composer send carries them out: intercept Enter
			// and the send button, attach the file at that instant, and submit.
			ctx.effect(() => {
				const onKey = (event) => {
					if (event.key !== 'Enter' || event.shiftKey || event.isComposing === true || event.keyCode === 229) return;
					if (controller.state.items.length === 0) return;
					const target = event.target;
					if (!(target instanceof HTMLElement) || target.isContentEditable !== true) return;
					const draft = (controller.composer?.getDraft?.() ?? '').trim();
					if (draft.startsWith('/')) return;
					event.preventDefault();
					event.stopPropagation();
					controller.flushAndSubmit();
				};
				document.addEventListener('keydown', onKey, true);
				return () => document.removeEventListener('keydown', onKey, true);
			}, 'browser-annotate: enter intercept');
			ctx.effect(() => {
				const onClick = (event) => {
					if (controller.state.items.length === 0) return;
					const button = event.target instanceof Element ? event.target.closest('button') : null;
					if (button === null) return;
					const label = (button.getAttribute('aria-label') ?? '').trim();
					// Exact send-verb labels only. Anchored so 编辑排队消息 never matches.
					if (!/^(发送消息|send message|queue message|steer message|排队发送|转向消息|插话发送)$/i.test(label)) return;
					event.preventDefault();
					event.stopPropagation();
					controller.flushAndSubmit();
				};
				document.addEventListener('click', onClick, true);
				return () => document.removeEventListener('click', onClick, true);
			}, 'browser-annotate: send click intercept');
			ctx.slots.inject('conversation.input.left', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.left',
						id: 'browser-annotate',
						order: 40,
						locale: NS,
						inject: () => ({ annotate: controller }),
					},
					AnnotateButton,
				),
			);
			ctx.slots.inject('conversation.input.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.dock',
						id: 'browser-annotate',
						order: 30,
						locale: NS,
						inject: (sessionId) => ({ annotate: controller, sessionId }),
					},
					AnnotateDock,
				),
			);
		}

		return { inject, apply };
	},
});

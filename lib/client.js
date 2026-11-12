/* dsh-ai-passport — hand-written client bundle (no build step, no JSX). */
window.__ModuleLoader__.load({
  id: "dsh-ai-passport",
  factory: function (require) {
    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var PANEL_ID = "ai-passport";
    var API = "/dsh-passport";

    /*
     * Host contract (the host half registers these routes on the same origin):
     *   GET  /dsh-passport/state.json -> { state: <panelSnapshot output> }
     *   POST /dsh-passport/action     -> { ok, state?, error? }
     * Actions:
     *   link.connect / link.disconnect / link.restartScan
     *   pair.submit { code } / pair.unpair
     *
     * The UI never derives a device/pairing/ASR value locally: every displayed
     * domain value comes from state.json, and every button performs a POST.
     */
    var LINK_COLORS = {
      idle: "#8a8f98",
      scanning: "#d9a400",
      connecting: "#d9a400",
      connected: "#2e9e5b",
      reconnecting: "#d97706",
      failed: "#d14343",
    };

    function text(value, fallback) {
      return typeof value === "string" && value.length > 0 ? value : fallback;
    }

    function display(value) {
      return value === null || value === undefined || value === "" ? "未上报" : String(value);
    }

    function deviceText(value, suffix) {
      if (value === null || value === undefined || value === "") return "设备未上报";
      return String(value) + (suffix || "");
    }

    function capabilityText(data) {
      if (data.deviceCapabilities == null) return "设备未上报";
      if (!Array.isArray(data.deviceCapabilityLabels) || data.deviceCapabilityLabels.length === 0) {
        return data.deviceCapabilities === 0 ? "未声明" : "仅保留能力位";
      }
      return data.deviceCapabilityLabels.join(" / ") + "（0x" + Number(data.deviceCapabilities).toString(16) + "）";
    }

    function handshakeText(value) {
      if (value === "ready") return "已就绪";
      if (value === "handshaking") return "握手中";
      return "设备未上报";
    }

    function readJson(response) {
      return response.text().then(function (raw) {
        if (!raw) return {};
        try {
          return JSON.parse(raw);
        } catch {
          return {};
        }
      });
    }

    function fetchState() {
      return fetch(API + "/state.json", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }).then(function (response) {
        return readJson(response).then(function (body) {
          if (!response.ok) {
            throw new Error("面板服务返回 HTTP " + response.status);
          }
          var state = body && body.state ? body.state : body;
          if (!state || typeof state !== "object") {
            throw new Error("面板服务返回了空状态");
          }
          return state;
        });
      });
    }

    function postAction(action, payload) {
      return fetch(API + "/action", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ action: action, payload: payload || {} }),
      }).then(function (response) {
        return readJson(response).then(function (body) {
          if (!response.ok || (body && body.ok === false)) {
            throw new Error((body && body.error) || "动作失败（HTTP " + response.status + "）");
          }
          return body || {};
        });
      });
    }

    function usePanelState() {
      var initial = { data: null, error: null, loading: true, busy: false, actionError: null, updatedAt: 0 };
      var [model, setModel] = useState(initial);
      var loadRef = useRef(null);

      useEffect(function () {
        var alive = true;

        function load() {
          return fetchState()
            .then(function (state) {
              if (!alive) return;
              setModel(function (prev) {
                return {
                  data: state,
                  error: null,
                  loading: false,
                  busy: prev.busy,
                  actionError: prev.actionError,
                  updatedAt: Date.now(),
                };
              });
            })
            .catch(function (err) {
              if (!alive) return;
              setModel(function (prev) {
                return {
                  data: prev.data,
                  error: err && err.message ? err.message : "面板服务未响应",
                  loading: false,
                  busy: prev.busy,
                  actionError: prev.actionError,
                  updatedAt: prev.updatedAt,
                };
              });
            });
        }

        loadRef.current = load;
        load();
        var timer = window.setInterval(load, 2000);
        return function () {
          alive = false;
          window.clearInterval(timer);
          loadRef.current = null;
        };
      }, []);

      function act(action, payload) {
        setModel(function (prev) {
          return { ...prev, busy: true, actionError: null };
        });
        return postAction(action, payload)
          .then(function (body) {
            setModel(function (prev) {
              var nextData = body && body.state && typeof body.state === "object" ? body.state : prev.data;
              return {
                ...prev,
                data: nextData,
                busy: false,
                error: null,
                actionError: null,
                updatedAt: nextData ? Date.now() : prev.updatedAt,
              };
            });
            if (loadRef.current) loadRef.current();
            return body;
          })
          .catch(function (err) {
            var message = err && err.message ? err.message : "动作失败";
            setModel(function (prev) {
              return { ...prev, busy: false, actionError: message };
            });
            throw err;
          });
      }

      function reload() {
        if (loadRef.current) return loadRef.current();
        return Promise.resolve();
      }

      return { model: model, act: act, reload: reload };
    }

    var styles = {
      root: { padding: "16px", color: "var(--dsh-text, #1f2328)", fontSize: 13, lineHeight: 1.5 },
      header: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 },
      title: { fontSize: 16, fontWeight: 600, margin: 0 },
      zones: { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" },
      section: { flex: "1 1 280px", minWidth: 0, boxSizing: "border-box", border: "1px solid var(--dsh-border, #d8dee4)", borderRadius: 8, padding: "12px" },
      sectionTitle: { fontSize: 13, fontWeight: 600, margin: "0 0 8px" },
      row: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, padding: "3px 0" },
      label: { color: "var(--dsh-muted, #656d76)" },
      value: { textAlign: "right", wordBreak: "break-all" },
      note: { color: "var(--dsh-muted, #656d76)", margin: "8px 0 0", fontSize: 12, wordBreak: "break-word" },
      error: { border: "1px solid #d14343", background: "#fff1f1", color: "#a40e0e", borderRadius: 6, padding: "8px 10px", marginBottom: 12 },
      capsule: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 999, background: "var(--dsh-surface, #f6f8fa)" },
      dot: { width: 8, height: 8, borderRadius: "50%", display: "inline-block", flex: "0 0 auto" },
      actions: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 },
      button: { border: "1px solid var(--dsh-border, #d8dee4)", background: "var(--dsh-surface, #f6f8fa)", color: "inherit", borderRadius: 6, padding: "4px 10px", cursor: "pointer" },
      primary: { border: "1px solid #1f6feb", background: "#1f6feb", color: "#fff" },
      input: { border: "1px solid var(--dsh-border, #d8dee4)", borderRadius: 6, padding: "4px 8px", width: 96, maxWidth: "100%", font: "inherit" },
      badge: { background: "#d14343", color: "#fff", borderRadius: 999, padding: "0 6px", fontSize: 11 },
      bottom: { width: "100%", border: 0, background: "#101418", color: "#f6f8fa", padding: "5px 12px", cursor: "pointer", textAlign: "left", fontSize: 12, display: "flex", flexWrap: "wrap", alignItems: "center" },
      inline: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 },
    };

    function Section(props) {
      return h(
        "section",
        { style: styles.section, "aria-label": props.title },
        h("h3", { style: styles.sectionTitle }, props.title),
        props.children,
      );
    }

    function Row(props) {
      return h(
        "div",
        { style: styles.row },
        h("span", { style: styles.label }, props.label),
        h("span", { style: styles.value }, props.children),
      );
    }

    function Button(props) {
      var style = props.primary ? { ...styles.button, ...styles.primary } : styles.button;
      return h(
        "button",
        {
          type: "button",
          style: style,
          disabled: props.disabled,
          onClick: props.onClick,
        },
        props.label,
      );
    }

    function ActionBar(props) {
      var model = props.model;
      return h(
        "div",
        { style: styles.actions },
        h(Button, {
          label: "连接",
          primary: true,
          disabled: model.busy,
          onClick: function () { props.run("link.connect", {}); },
        }),
        h(Button, {
          label: "断开",
          disabled: model.busy,
          onClick: function () { props.run("link.disconnect", {}); },
        }),
        h(Button, {
          label: "换设备",
          disabled: model.busy,
          onClick: function () { props.run("link.restartScan", {}); },
        }),
        h(Button, {
          label: "刷新",
          disabled: model.busy,
          onClick: function () { props.reload(); },
        }),
      );
    }

    function LinkSection(props) {
      var data = props.data || {};
      var color = LINK_COLORS[data.linkState] || LINK_COLORS.idle;
      return h(
        Section,
        { title: "链路" },
        h(
          "div",
          { style: styles.capsule },
          h("span", { style: { ...styles.dot, background: color } }),
          h("strong", null, text(data.linkLabel, "状态未知")),
          data.linkReady ? h("span", { style: styles.label }, "握手完成") : h("span", { style: styles.label }, "未握手"),
          data.attentionCount > 0 ? h("span", { style: styles.badge }, "关注 " + data.attentionCount) : null,
        ),
        data.linkError ? h("p", { style: styles.note, role: "alert" }, data.linkError) : null,
        h(ActionBar, { model: props.model, run: props.run, reload: props.reload }),

      );
    }

    function DeviceSection(props) {
      var data = props.data || {};
      return h(
        Section,
        { title: "设备信息" },
        h(Row, { label: "型号" }, deviceText(data.deviceModel)),
        h(Row, { label: "名称" }, deviceText(data.deviceName)),
        h(Row, { label: "设备 ID" }, deviceText(data.deviceId)),
        h(Row, { label: "固件版本" }, deviceText(data.deviceFirmware)),
        h(Row, { label: "MTU" }, deviceText(data.deviceMtu)),
        h(Row, { label: "消息上限" }, deviceText(data.deviceMaxPayload, " 字节")),
        h(Row, { label: "分片上限" }, deviceText(data.deviceMaxChunks, " 片")),
        h(Row, { label: "能力位" }, capabilityText(data)),
        h(Row, { label: "电量" }, data.deviceBattery == null ? "设备未上报" : data.deviceBattery + "%"),
        h(Row, { label: "信号" }, data.deviceSignal == null ? "设备未上报" : String(data.deviceSignal)),
        h(Row, { label: "握手" }, handshakeText(data.deviceHandshake)),
        data.deviceCapabilityNote ? h("p", { style: styles.note }, data.deviceCapabilityNote) : null,
        data.deviceNote ? h("p", { style: styles.note }, data.deviceNote) : null,
      );
    }

    function PairingSection(props) {
      var data = props.data || {};
      var model = props.model;
      var [code, setCode] = useState("");
      var [localError, setLocalError] = useState(null);

      function submit() {
        if (!/^\d{6}$/.test(code)) {
          setLocalError("请输入设备屏幕上显示的 6 位数字配对码");
          return;
        }
        setLocalError(null);
        props.run("pair.submit", { code: code }).then(
          function (ok) { if (ok) setCode(""); },
        );
      }

      if (data.pairingPaired) {
        return h(
          Section,
          { title: "配对码" },
          h(Row, { label: "状态" }, "已配对"),
          h(Row, { label: "设备" }, display(data.pairingDeviceId)),
          h(Row, { label: "主机名" }, display(data.pairingHostName)),
          h(
            "div",
            { style: styles.actions },
            h(Button, {
              label: "解除配对",
              disabled: model.busy,
              onClick: function () { props.run("pair.unpair", {}); },
            }),
          ),
          data.pairingError ? h("p", { style: styles.note, role: "alert" }, data.pairingError) : null,
        );
      }

      var disabled = !data.linkReady || model.busy;
      return h(
        Section,
        { title: "配对码" },
        h("p", { style: styles.note }, text(data.pairingNote, "设备未连接，配对不可用")),
        typeof data.pairingRemaining === "number"
          ? h(Row, { label: "剩余尝试" }, String(data.pairingRemaining))
          : null,
        h(
          "div",
          { style: { ...styles.inline, marginTop: 8 } },
          h("input", {
            style: styles.input,
            inputMode: "numeric",
            maxLength: 6,
            placeholder: "6 位配对码",
            value: code,
            disabled: disabled,
            onChange: function (event) {
              setCode(String(event.target.value || "").replace(/\D/g, "").slice(0, 6));
            },
          }),
          h(Button, {
            label: "提交配对",
            primary: true,
            disabled: disabled,
            onClick: submit,
          }),
        ),
        localError ? h("p", { style: styles.note, role: "alert" }, localError) : null,
        data.pairingError ? h("p", { style: styles.note, role: "alert" }, data.pairingError) : null,
      );
    }

    function AsrSection(props) {
      var data = props.data || {};
      var last = data.asrLastResultSummary;
      return h(
        Section,
        { title: "ASR 状态" },
        h(Row, { label: "状态" }, text(data.asrStateLabel, "未获取")),
        h(Row, { label: "服务" }, data.asrAvailable ? "已配置" : "不可用"),
        h(Row, { label: "提供者" }, display(data.asrProvider)),
        h(Row, { label: "活动会话" }, data.asrSessionCount == null ? "未上报" : String(data.asrSessionCount)),
        h(
          "div",
          { style: { marginTop: 8 } },
          h("span", { style: styles.label }, "上次结果"),
          last
            ? h("p", { style: { ...styles.note, marginTop: 4 } }, last)
            : h("p", { style: styles.note }, data.asrAvailable ? "暂无结果" : "未获取"),
        ),
        h("p", { style: styles.note }, text(data.asrNote, "状态未获取")),
        data.asrDetail ? h("p", { style: styles.note }, data.asrDetail) : null,
        data.asrError ? h("p", { style: styles.note, role: "alert" }, data.asrError) : null,
      );
    }

    function Panel() {
      var panel = usePanelState();
      var model = panel.model;
      var data = model.data || {};

      function run(action, payload) {
        return panel.act(action, payload).then(
          function () { return true; },
          function () { return false; },
        );
      }

      return h(
        "div",
        { style: styles.root },
        h(
          "div",
          { style: styles.header },
          h("h2", { style: styles.title }, "AI Passport"),
          h("span", { style: styles.label }, model.updatedAt ? "更新于 " + new Date(model.updatedAt).toLocaleTimeString() : "未更新"),
        ),
        model.error ? h("div", { style: styles.error, role: "alert" }, "读取面板失败：" + model.error) : null,
        model.actionError ? h("div", { style: styles.error, role: "alert" }, "动作失败：" + model.actionError) : null,
        model.loading && !model.data ? h("p", { style: styles.note }, "正在读取宿主状态…") : null,
        /*
         * Four independent cards, in this order: link capsule / device / pairing / ASR.
         * No approval, balance, or task card here (docs/02 D33); ASR is read-only status
         * and never inserts a transcription into an editor (docs/02 D28).
         */
        h(
          "div",
          { style: styles.zones },
          h(LinkSection, { data: data, model: model, run: run, reload: panel.reload }),
          h(DeviceSection, { data: data }),
          h(PairingSection, { data: data, model: model, run: run }),
          h(AsrSection, { data: data }),
        ),
      );
    }

    function LinkCapsule(props) {
      var panel = usePanelState();
      var data = panel.model.data || {};
      var color = LINK_COLORS[data.linkState] || LINK_COLORS.idle;
      return h(
        "button",
        {
          type: "button",
          style: styles.bottom,
          onClick: function () {
            if (props && typeof props.onClick === "function") {
              props.onClick();
            }
          },
        },
        h("span", { style: { ...styles.dot, background: color, marginRight: 8 } }),
        "AI Passport · " + text(data.linkLabel, "状态未知"),
        data.attentionCount > 0 ? " · 关注 " + data.attentionCount : "",
      );
    }

    function SidebarIcon() {
      return h(
        "span",
        {
          "aria-label": "AI Passport",
          title: "AI Passport",
          style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, fontWeight: 700, fontSize: 10 },
        },
        "AI",
      );
    }

    function openPanel(ctx) {
      try {
        var layout = ctx && typeof ctx.get === "function" ? ctx.get("layout") : null;
        if (layout && typeof layout.selectPanel === "function") {
          layout.selectPanel(PANEL_ID);
        }
      } catch {
        /* Sidebar registration itself remains usable if layout is absent. */
      }
    }

    function apply(ctx) {
      function boot() {
        var disposers = [];

        try {
          disposers.push(ctx.slots.inject("main", function () {
            return ctx.slots.register(
              { name: "main", key: PANEL_ID },
              function MainPanel() { return h(Panel, null); },
            );
          }));
        } catch (err) {
          console.warn("[ai-passport] main panel unavailable", err);
        }

        try {
          disposers.push(ctx.slots.inject("sidebar.panellist", function () {
            return ctx.slots.register(
              {
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: 40,
                label: function () { return "AI Passport"; },
              },
              function PassportIcon() {
                return h(
                  "button",
                  {
                    type: "button",
                    title: "AI Passport 面板",
                    onClick: function () { openPanel(ctx); },
                    style: { border: 0, background: "transparent", cursor: "pointer", padding: 0 },
                  },
                  h(SidebarIcon, null),
                );
              },
            );
          }));
        } catch (err) {
          console.warn("[ai-passport] sidebar entry unavailable", err);
        }

        // The real host layout package has a root-scoped shell.bottom slot
        // (dsh-client-ui-layout/lib/client.js:399,721). Put a second, compact
        // capsule there so link state stays visible outside the panel.
        try {
          disposers.push(ctx.slots.inject("shell.bottom", function () {
            return ctx.slots.register(
              { name: "shell.bottom" },
              function BottomCapsule() {
                return h(LinkCapsule, { onClick: function () { openPanel(ctx); } });
              },
            );
          }));
        } catch (err) {
          console.warn("[ai-passport] shell.bottom unavailable; capsule stays in main panel", err);
        }

        return function () {
          while (disposers.length > 0) {
            var dispose = disposers.pop();
            if (typeof dispose === "function") {
              try {
                dispose();
              } catch (err) {
                console.warn("[ai-passport] slot cleanup failed", err);
              }
            }
          }
        };
      }

      if (ctx && typeof ctx.effect === "function") {
        ctx.effect(function () {
          return boot();
        });
      } else {
        boot();
      }
    }

    return {
      name: "dsh-ai-passport",
      inject: ["slots", "layout"],
      apply: apply,
    };
  },
});

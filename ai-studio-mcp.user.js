// ==UserScript==
// @name        Google AI Studio MCP Integration
// @description Add (local) MCP support to Google AI Studio
// @match       https://aistudio.google.com/*
// @grant       GM_xmlhttpRequest
// @grant       GM.getValue
// @grant       GM.setValue
// ==/UserScript==

const tags = {
  chatTurn: "ms-chat-turn",
  functionCallChunk: "ms-function-call-chunk",
  functionDeclarationsDialog: "ms-edit-function-declarations-dialog",
  promptChunk: "ms-prompt-chunk",
  dialogActions: "mat-dialog-actions",
};


/**
 * Get the first parent with the desired tag if possible.
 * @param {Element} element
 * @param {string} tagName
 * @returns {Element | null}
 */
function getParentWithTag(element, tagName) {
  let parent = element.parentElement;
  const upperTagName = tagName.toUpperCase();

  while (parent) {
    if (parent.tagName === upperTagName) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}


/**
 * Safely select an element using a CSS selector or raise an error.
 * @param {Element} element
 * @param {string} selector
 * @returns {HTMLElement}
 */
function safeQuerySelector(element, selector) {
  const selected = element.querySelector(selector);
  if (selected !== null) {
    // @ts-ignore
    return selected;
  } else {
    throw new Error(`Failed to select '${selector}' from '${element}'.`);
  }
}


/**
 * @param {String} html representing a single node.
 * @return {Element}
 */
function htmlToNode(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const numChildren = template.content.childElementCount;
  if (numChildren != 1) {
    throw new Error(`Expected exactly one child element, got ${numChildren}.`);
  }
  // @ts-ignore
  return template.content.firstChild;
}


/**
 * Parse a JSON-RPC message.
 * @param {string} payload
 */
function parseJsonRpcMessage(payload) {
  const parts = payload.trim().split("\n");
  if (parts[0] != "event: message") {
    throw new Error(`Expected message event, got '${parts[0]}'.`);
  }
  if (parts.length != 2) {
    throw new Error(`Expected message to have two lines, got ${parts.length}.`);
  }
  if (!parts[1].startsWith("data: ")) {
    throw new Error(`Expected 'data: ' prefix, got '${parts[1]}'.`);
  }
  return JSON.parse(parts[1].substring(6).trim());
}

/**
 * Set the value of a <textarea> element and dispatch an 'input' event.
 * @param {HTMLTextAreaElement} element
 * @param {string} value
 */
function setTextareaValue(element, value) {
  element.value = value;

  const inputEvent = new Event('input', {
    bubbles: true,
    cancelable: false,
    composed: true,
  });
  element.dispatchEvent(inputEvent);

  const changeEvent = new Event('change', {
    bubbles: true,
    cancelable: false
  });
  element.dispatchEvent(changeEvent);
}


/**
 *
 * @param {Function} func Function to attempt to complete.
 * @param {number} interval Polling interval in ms.
 * @param {number} timeout Timeout after which to give up in ms.
 * @returns {Promise}
 */
function pollUntil(func, interval, timeout) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const handle = setInterval(() => {
      try {
        const result = func();
        clearInterval(handle);
        resolve(result);
      } catch {
        if (Date.now() - start > timeout) {
          clearInterval(handle);
          reject(`Function '${func}' did not complete successfully in ${timeout} ms.`);
        }
      }
    }, interval);
  });
}


/**
 * Handle a function call.
 *
 * @param {HTMLElement} functionCall
 */
async function handleFunctionCall(functionCall) {
  // If there is no submit button, it's already been processed.
  /** @type {HTMLButtonElement | null} */
  const submitButton = functionCall.querySelector("button[type=submit]");
  if (submitButton === null) {
    return;
  }
  // Mark this as being processed so we don't handle it multiple times.
  if (functionCall.getAttribute("mcp-processing") == "true") {
    return;
  }
  functionCall.setAttribute("mcp-processing", "true");

  const nameElement = safeQuerySelector(functionCall, ".name");
  const payloadElement = safeQuerySelector(functionCall, "pre");
  const name = nameElement.innerText.trim();
  const arguments = JSON.parse(payloadElement.innerText.trim());
  console.log(`🔨 Calling '${name}' with arguments ${JSON.stringify(arguments)} ...`);

  const payload = {
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": name,
      "arguments": arguments,
    },
    "id": "4",
  };
  // @ts-ignore
  GM_xmlhttpRequest({
    method: "POST",
    // @ts-ignore
    url: await GM.getValue("mcpServerUrl", "http://localhost:7777"),
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json,text/event-stream",
    },
    onload: async (response) => {
      console.log(`✅ Received response with ${response.responseText.length} bytes.`);
      const payload = parseJsonRpcMessage(response.responseText);

      // Naively assume there is only one part.
      for (const part of payload.result.content) {
        /** @type {HTMLTextAreaElement} */
        // @ts-ignore
        const responseTextarea = safeQuerySelector(functionCall, "textarea");
        setTextareaValue(responseTextarea, part.text);
        // Submit automatically in autoSend mode.
        // @ts-ignore
        if (await GM.getValue("mcpAutoSubmit")) {
          try {
            pollUntil(() => {
              // @ts-ignore
              if (submitButton.disabled) {
                throw new Error("Response submit button is disabled.");
              }
              // This is a bit dirty to just wait, but there is some state that needs a
              // bit longer to update before we can submit.
              setTimeout(() => {
                console.log("🚀 Submitting response ...");
                submitButton.click();
              }, 500);
            }, 100, 1000);
          } catch {
            console.error("⚠️ Failed to auto-submit response.");
          }
        }
      }
    },
    onerror: function (error) {
      console.error("⚠️ Failed to get response.");
    },
    data: JSON.stringify(payload),
  });
}


// Add an import button to the function declaration.
/** @param {Element} node */
async function addFunctionDeclarationImportButton(node) {
  const dialogHelp = safeQuerySelector(node, "mat-dialog-content");
  const mcpContainer = htmlToNode(
    `<div class="mcp-dialog-container">
      <div class="mcp-flex">
        <input type="text" placeholder="MCP Server Url" id="mcpServerUrlInput">
        <button
            class="mdc-button mat-mdc-button-base gmat-mdc-button light mat-mdc-button mat-mcp"
            id="loadMcpToolsButton">
          Load MCP Tools
        </button>
      </div>
      <div>
        <input type="checkbox" id="mcpAutoSubmitCheckbox">
        <label for="autoSubmit">Automatically submit tool results</label><br>
      </div>
    </div>`
  );
  // @ts-ignore
  dialogHelp.parentElement.insertBefore(mcpContainer, dialogHelp);

  /** @type {HTMLInputElement} */
  // @ts-ignore
  const urlInput = safeQuerySelector(mcpContainer, "#mcpServerUrlInput");
  // @ts-ignore
  urlInput.value = await GM.getValue("mcpServerUrl");

  const button = safeQuerySelector(mcpContainer, "#loadMcpToolsButton");
  button.addEventListener("click", async () => {
    const payload = {
      "jsonrpc": "2.0",
      "method": "tools/list",
      "params": {},
      "id": "4"
    };
    // @ts-ignore
    GM_xmlhttpRequest({
      method: "POST",
      // @ts-ignore
      url: urlInput.value,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json,text/event-stream",
      },
      onload: async function (response) {
        const payload = parseJsonRpcMessage(response.responseText);

        // Transform the tools to the format that's expected by Gemini. It's
        // almost the same format as mcp but they use "parameters" instead of
        // "inputSchema".
        const functions = payload.result.tools.map(tool => {
          // Delete additional fields that Google doesn't recognize.
          const parameters = tool.inputSchema;
          delete parameters.additionalProperties;
          delete parameters["$schema"];

          // Add standard string type if none is set and delete defaults that are
          // not supported in AI Studio.
          for (const key in parameters.properties) {
            if (parameters.properties[key].type === undefined) {
              parameters.properties[key].type = "string";
            }
            delete parameters.properties[key].default;
          }

          return {
            name: tool.name,
            description: tool.description.trim(),
            parameters: parameters,
          }
        });
        const declarationJson = JSON.stringify(functions, null, 2);

        /** @type {HTMLTextAreaElement} */
        // @ts-ignore
        const textarea = safeQuerySelector(node, "textarea");
        setTextareaValue(textarea, declarationJson);
        // @ts-ignore
        await GM.setValue("mcpServerUrl", urlInput.value);
      },
      onerror: function (error) {
        alert(`Failed to load tools from '${urlInput.value}'.`)
      },
      data: JSON.stringify(payload),
    });
  });

  /** @type {HTMLInputElement} */
  // @ts-ignore
  const checkbox = safeQuerySelector(mcpContainer, "#mcpAutoSubmitCheckbox");
  // @ts-ignore
  checkbox.checked = await GM.getValue("mcpAutoSubmit");
  checkbox.addEventListener("click", async () => {
    // @ts-ignore
    await GM.setValue("mcpAutoSubmit", checkbox.checked);
    console.log(`Changed mcpAutoSubmit to '${checkbox.checked}'.`)
  });
}


/**
 * Observe changes.
 * @param {Array<MutationRecord>} mutationsList
 * @param {*} observer
 */
function mutationCallback(mutationsList, observer) {
  for (const mutation of mutationsList) {
    if (mutation.type === "childList") {
      /** @type {HTMLElement} */
      let node;
      // @ts-ignore
      for (node of mutation.addedNodes) {
        const tagName = node.tagName.toLowerCase();
        if (tagName == tags.functionDeclarationsDialog) {
          addFunctionDeclarationImportButton(node);
        } else {
          const functionCalls = node.getElementsByTagName(tags.functionCallChunk);
          for (const functionCall of functionCalls) {
            // @ts-ignore
            handleFunctionCall(functionCall);
          }
        }
      }
    }
  }
};


(function () {
  // Inject custom styles.
  document.body.append(htmlToNode(
    `<style>
      :root {
        --color-mcp: #f89c21;
        --color-mcp-l35: #fde9ce;
      }

      .mcp-flex {
        display: flex;
        align-items: center;
        flax-wrap: nowrap;
        margin-bottom: 4px;
      }

      .mcp-dialog-container {
        padding-left: 16px;
        padding-right: 16px;
        padding-top: 8px;
        padding-bottom: 8px;
      }

      .mcp-dialog-container input[type=text] {
        margin-right: 8px;
        flex-grow: 1;
        min-width: 200px;
        border-radius: 4px;
        border-color: var(--color-mcp-l35);
        border-style: solid;
        padding: 5px;
      }

      .mcp-dialog-container button {
        background-color: var(--color-mcp);
      }
    </style>`
  ))

  const observer = new MutationObserver(mutationCallback);
  const config = { childList: true, subtree: true };
  observer.observe(document.body, config);
})();

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

const config = {
  autoSend: true,
};


async function getMcpServerUrl() {
  // @ts-ignore
  return await GM.getValue("mcpServerUrl", "http://localhost:7777");
}


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
 * @param {String} html representing a single node.
 * @return {HTMLElement}
 */
function htmlToNode(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  if (template.content.firstChild) {
    // @ts-ignore
    return template.content.firstChild;
  } else { throw new Error("No child.") }
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

function setTextareaValue(element, value) {
  element.value = value;
  // Manually dispatch the 'input' event
  const inputEvent = new Event('input', {
    bubbles: true,    // Whether the event bubbles up through the DOM
    cancelable: true  // Whether the event is cancelable
  });
  element.dispatchEvent(inputEvent);
}


/**
 * Handle the addition of a chat turn.
 * @param {HTMLElement} node
 */
async function handleChatTurn(node) {
  if (node.querySelector(".user-prompt-container")) {
    console.log("Skipping user prompt.");
    return;
  }
  if (node.querySelector("ms-thought-chunk")) {
    console.log("Skipping thought chunk.");
    return;
  }
  const functionCall = node.querySelector(tags.functionCallChunk);
  if (functionCall) {
    /** @type {HTMLElement | null} */
    const nameElement = functionCall.querySelector(".name");
    const payloadElement = functionCall.querySelector("pre");
    if (nameElement && payloadElement) {
      const name = nameElement.innerText.trim();
      const arguments = payloadElement.innerText.trim();
      console.log(`Calling ${name} with arguments ${arguments} ...`);

      const payload = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": {
          "name": name,
          "arguments": JSON.parse(arguments),
        },
        "id": "4",
      };
      // @ts-ignore
      GM_xmlhttpRequest({
        method: "POST",
        url: await getMcpServerUrl(),
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json,text/event-stream",
        },
        onload: function (response) {
          const payload = parseJsonRpcMessage(response.responseText);
          console.log(payload);

          // Naively assume there is only one part.
          for (const part of payload.result.content) {
            const responseTextarea = functionCall.querySelector("textarea");
            if (responseTextarea) {
              setTextareaValue(responseTextarea, part.text);
              // Submit automatically in autoSend mode.
              if (config.autoSend) {
                console.log("Attempting to submit results automatically ..");
                /** @type {HTMLElement | null} */
                const submitButton = functionCall.querySelector("button[type=submit]");
                if (submitButton) {
                  submitButton.click();
                }
              }
            } else {
              console.error("Failed to paste response because text area is missing.");
            }
          }
        },
        onerror: function (error) {
          console.error(error);
        },
        data: JSON.stringify(payload),
      });
    }
    else {
      console.error("Found function call chunk but cannot get name and payload.");
    }
  } else {
    console.log("This chat turn does not contain a function call ...");
    console.log(node);
  }
}

// Add an import button to the function declaration.
/** @param {Element} node */
async function addFunctionDeclarationImportButton(node) {
  const actions = node.querySelector(tags.dialogActions);
  const urlInput = htmlToNode(
    `<input placeholder="MCP Server Url" style="margin-right: 8px; flex-grow: 1; min-width: 200px;">`
  );
  const button = htmlToNode(
    `<button class="mdc-button mat-mdc-button-base gmat-mdc-button light mat-mdc-button mat-mcp">
      <span class="mat-mdc-button-persistent-ripple mdc-button__ripple"></span>
      <span class="mdc-button__label"> Import from MCP </span>
      <span class="mat-focus-indicator"></span>
      <span class="mat-mdc-button-touch-target"></span>
      <span class="mat-ripple mat-mdc-button-ripple"></span>
    </button>`
  );
  if (actions && button && urlInput) {

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

          const textarea = node.querySelector("textarea");
          if (!textarea) {
            return;
          }

          setTextareaValue(textarea, declarationJson);
          // @ts-ignore
          await GM.setValue("mcpServerUrl", urlInput.value);
        },
        onerror: function (error) {
          console.error(error);
        },
        data: JSON.stringify(payload),
      });
    });
    actions.insertBefore(button, actions.firstChild);

    // @ts-ignore
    urlInput.value = await getMcpServerUrl();
    actions.insertBefore(urlInput, actions.firstChild);
  } else {
    console.error("could not find some elements");
  }
}


function mutationCallback(mutationsList, observer) {
  for (const mutation of mutationsList) {
    if (mutation.type === "childList") {
      for (const node of mutation.addedNodes) {
        // console.log(`Added node ${node.tagName}.`);
        if (node.tagName.toLowerCase() == tags.chatTurn) {
          handleChatTurn(node);
        } else if (node.tagName.toLowerCase() == tags.functionDeclarationsDialog) {
          addFunctionDeclarationImportButton(node);
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

      .gmat-mdc-button.mat-mcp {
        background-color: var(--color-mcp-l35);
      }

      .gmat-mdc-button.mat-mcp:hover {
        background-color: var(--color-mcp);
      }

      .gmat-mdc-button.mat-mcp:hover .mdc-button__label {
          color: var(--color-on-primary);
      }

      .mat-mdc-dialog-actions {
        display: flex;           /* Enables Flexbox */
        align-items: center;     /* Optional: vertically aligns items */
        flex-wrap: nowrap;       /* Prevents items from wrapping to the next line */
      }
    </style>`
  ))

  const observer = new MutationObserver(mutationCallback);
  const config = { childList: true, subtree: true };
  observer.observe(document.body, config);
})();

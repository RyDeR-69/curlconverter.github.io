import * as curlconverter from 'curlconverter'

const RUST_RESERVED = new Set([
  'type', 'match', 'fn', 'mod', 'pub', 'use',
  'impl', 'struct', 'enum', 'trait', 'const',
  'let', 'move', 'ref', 'mut', 'async', 'await',
  'loop', 'break', 'continue', 'return', 'if',
  'else', 'for', 'while', 'in', 'self', 'super',
  'crate', 'where', 'as', 'dyn', 'abstract',
  'final', 'override', 'macro', 'extern',
  'static', 'union', 'unsafe', 'true', 'false'
])

// Additional keywords that should be avoided
const RUST_WEAK_KEYWORDS = new Set([
  'macro_rules', 'union', 'yield'
])

// Maps HAR HTTP method to reqwest::Method variant
const methodMap = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS'
}

// Headers to ignore
const IGNORED_HEADERS = new Set([
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-dest',
  'sec-fetch-user',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'upgrade-insecure-requests',
  'user-agent',
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'host',
  'priority',
  'platform'
])

function rustStr (str) {
  return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// Simple hash function for generating consistent parameter names
function simpleHash (str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36).substring(0, 8)
}

// Convert parameter name to valid Rust identifier and return both original and converted
function convertParamName (paramName) {
  if (!paramName || typeof paramName !== 'string') {
    return {
      original: paramName || '',
      rust: 'unnamed_param',
      needsRename: true
    }
  }

  // Handle empty or whitespace-only strings
  if (!paramName.trim()) {
    return {
      original: paramName,
      rust: 'empty_param',
      needsRename: true
    }
  }

  let rustName = paramName
    // Handle common acronyms and abbreviations
    .replace(/([a-z])([A-Z]{2,})/g, '$1_$2') // camelCaseXML -> camel_case_xml
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1_$2') // XMLHttpRequest -> xml_http_request
    // Standard camelCase to snake_case
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase()
    // Replace sequences of non-alphanumeric characters with single underscore
    .replace(/[^a-zA-Z0-9]+/g, '_')
    // Handle leading digits (Rust identifiers can't start with numbers)
    .replace(/^(\d)/, '_$1')
    // Collapse multiple underscores
    .replace(/_+/g, '_')
    // Remove leading and trailing underscores
    .replace(/^_+|_+$/g, '')

  // Handle completely empty result after cleaning
  if (!rustName) {
    rustName = 'cleaned_param'
  }

  // Handle single character names that might be problematic
  if (rustName.length === 1) {
    if (/[0-9]/.test(rustName)) {
      rustName = `num_${rustName}`
    } else if (!/[a-z]/.test(rustName)) {
      rustName = 'single_char'
    }
  }

  // Check for reserved keywords
  if (RUST_RESERVED.has(rustName) || RUST_WEAK_KEYWORDS.has(rustName)) {
    rustName += '_param'
  }

  // Handle edge cases where the name is still problematic
  if (rustName === 'r' || rustName === 'raw') {
    rustName = rustName + '_field'
  }

  // Ensure we have a valid identifier
  if (!/^[a-z_][a-z0-9_]*$/.test(rustName)) {
    // If we still don't have a valid identifier, create a hash-based one
    rustName = `param_${simpleHash(paramName)}`
  }

  return {
    original: paramName,
    rust: rustName,
    needsRename: rustName !== paramName
  }
}

function jsonParamType (val) {
  if (typeof val === 'number') {
    return Number.isInteger(val) ? 'i64' : 'f64'
  }
  if (typeof val === 'boolean') return 'bool'
  if (Array.isArray(val)) return 'Vec<serde_json::Value>'
  if (val === null) return 'Option<serde_json::Value>'
  if (typeof val === 'object') return 'serde_json::Value'
  // Default to String for everything else
  return 'String [into]'
}

// Generate default value for a given type and actual value
function generateDefaultValue (val) {
  if (typeof val === 'number') {
    return val.toString()
  }
  if (typeof val === 'boolean') {
    return val.toString()
  }
  if (Array.isArray(val)) {
    return 'vec![]'
  }
  if (val === null) {
    return 'None'
  }
  if (typeof val === 'object') {
    return 'serde_json::Value::Null'
  }
  // For strings and everything else
  return rustStr(String(val))
}

// Extract path parameters from URL
function extractPathParams (url) {
  const pathParams = []
  const paramRegex = /\{([^}]+)}/g
  let match

  while ((match = paramRegex.exec(url)) !== null) {
    const rawParamName = match[1].trim()
    if (rawParamName) {
      const converted = convertParamName(rawParamName)
      pathParams.push(converted)
    }
  }

  return pathParams
}

// Generate parameter definition for defaults section
function generateDefaultParamDef (paramName, paramValue = null, defaultValue = null) {
  const converted = convertParamName(paramName)
  const paramType = paramValue !== null ? jsonParamType(paramValue) : 'String [into]'
  const serdeRename = converted.needsRename
    ? `#[serde(rename = "${converted.original}")]\n                `
    : ''

  let actualDefaultValue = defaultValue
  if (actualDefaultValue === null) {
    if (paramValue !== null) {
      actualDefaultValue = generateDefaultValue(paramValue, paramType)
    } else {
      actualDefaultValue = rustStr('')
    }
  }

  return `${serdeRename}${converted.rust}: ${paramType} = ${actualDefaultValue},`
}

// HAR Request to declare_endpoint! Rust macro with defaults
function harToRustEndpointMacroDefaults (harReq, endpointName = 'Root', options = {}) {
  const { url, method, headers = [], queryString = [], postData, cookies = [] } = harReq

  const rustMethod = methodMap[String(method).toUpperCase()] || 'GET'

  const pathParams = extractPathParams(url)

  // Headers: All with defaults, filtered to exclude ignored headers
  const headerDefs = headers
    .filter(h => h && h.name && !IGNORED_HEADERS.has(h.name.toLowerCase()))
    .map(h => generateDefaultParamDef(h.name, h.value, rustStr(h.value || '')))

  // Query: All with defaults
  const queryDefs = queryString
    .filter(q => q && q.name)
    .map(q => generateDefaultParamDef(q.name, q.value, rustStr(q.value || '')))

  // Cookies: All with defaults
  const cookieDefs = cookies
    .filter(c => c && c.name)
    .map(c => generateDefaultParamDef(c.name, c.value, rustStr(c.value || '')))

  // JSON body: All with defaults
  let jsonDefs = []
  if (postData && postData.mimeType && postData.mimeType.includes('json') && postData.text) {
    try {
      const parsed = JSON.parse(postData.text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        jsonDefs = Object.entries(parsed)
          .filter(([k]) => k != null)
          .map(([k, v]) => generateDefaultParamDef(k, v))
      } else {
        jsonDefs = [generateDefaultParamDef('body', postData.text, rustStr(postData.text))]
      }
    } catch {
      // fallback: treat as generic string
      jsonDefs = [generateDefaultParamDef('body', postData.text, rustStr(postData.text || ''))]
    }
  } else if (postData && postData.text) {
    jsonDefs = [generateDefaultParamDef('body', postData.text, rustStr(postData.text))]
  }

  // Build path section only if there are path parameters
  const pathSection = pathParams.length > 0
    ? `path {
            defaults {
                ${pathParams.map(p => `${p.rust}: String [into] = "",`).join('\n                ')}
            }
        }

        `
    : ''

  // Build query section only if there are query parameters
  const querySection = queryDefs.length > 0
    ? `query {
            defaults {
                ${queryDefs.join('\n                ')}
            }
        }
        `
    : ''

  // Build json section only if there are json parameters
  const jsonSection = jsonDefs.length > 0
    ? `json {
            defaults {
                ${jsonDefs.join('\n                ')}
            }
        }
        `
    : ''

  // Build headers section only if there are headers
  const headersSection = headerDefs.length > 0 && !options.hideHeaders
    ? `headers {
            defaults {
                ${headerDefs.join('\n                ')}
            }
        }
        `
    : ''

  // Build cookies section only if there are cookies
  const cookiesSection = cookieDefs.length > 0 && !options.hideCookies
    ? `cookies {
            url: ${rustStr(url)},
            defaults {
                ${cookieDefs.join('\n                ')}
            }
        }
        `
    : ''

  // Clean up trailing whitespace and newlines
  const sections = [pathSection, querySection, jsonSection, headersSection, cookiesSection]
    .filter(s => s.trim().length > 0)
    .join('')
    .replace(/\n\s*$/, '')

  const attachAttribute = options.addAttach ? '#[attach(Client)]\n    ' : ''

  return `declare_endpoint! {
    ${attachAttribute}pub ${endpointName} => serde_json::Value {
        url: ${rustStr(url)},
        method: reqwest::Method::${rustMethod},

        ${sections}
    }
}`
}

// Original version with required fields (your existing code)
function harToRustEndpointMacro (harReq, endpointName = 'Root', options = {}) {
  const { url, method, headers = [], queryString = [], postData, cookies = [] } = harReq

  const rustMethod = methodMap[String(method).toUpperCase()] || 'GET'

  const pathParams = extractPathParams(url)

  // Headers: All required, with serde renames if needed, filtered to exclude ignored headers
  const headerDefs = headers
    .filter(h => h && h.name && !IGNORED_HEADERS.has(h.name.toLowerCase()))
    .map(h => {
      const converted = convertParamName(h.name)
      const serdeRename = converted.needsRename
        ? `#[serde(rename = "${converted.original}")]\n                `
        : ''
      return `${serdeRename}${converted.rust}: String [into],`
    })

  // Query: All required, with serde renames if needed
  const queryDefs = queryString
    .filter(q => q && q.name)
    .map(q => {
      const converted = convertParamName(q.name)
      const serdeRename = converted.needsRename
        ? `#[serde(rename = "${converted.original}")]\n                `
        : ''
      return `${serdeRename}${converted.rust}: String [into],`
    })

  // Cookies: All required, with serde renames if needed
  const cookieDefs = cookies
    .filter(c => c && c.name)
    .map(c => {
      const converted = convertParamName(c.name)
      const serdeRename = converted.needsRename
        ? `#[serde(rename = "${converted.original}")]\n                `
        : ''
      return `${serdeRename}${converted.rust}: String [into],`
    })

  // JSON body: All required, with serde renames if needed
  let jsonDefs = []
  if (postData && postData.mimeType && postData.mimeType.includes('json') && postData.text) {
    try {
      const parsed = JSON.parse(postData.text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        jsonDefs = Object.entries(parsed)
          .filter(([k]) => k != null)
          .map(([k, v]) => {
            const converted = convertParamName(k)
            const serdeRename = converted.needsRename
              ? `#[serde(rename = "${converted.original}")]\n                `
              : ''
            return `${serdeRename}${converted.rust}: ${jsonParamType(v)},`
          })
      } else {
        jsonDefs = ['body: serde_json::Value,']
      }
    } catch {
      // fallback: treat as generic string
      jsonDefs = ['body: String [into],']
    }
  } else if (postData && postData.text) {
    jsonDefs = ['body: String [into],']
  }

  // Build path section only if there are path parameters
  const pathSection = pathParams.length > 0
    ? `path {
            ${pathParams.map(p => `${p.rust}: String [into],`).join('\n            ')}
        }

        `
    : ''

  // Build query section only if there are query parameters
  const querySection = queryDefs.length > 0
    ? `query {
            required {
                ${queryDefs.join('\n                ')}
            }
        }
        `
    : ''

  // Build json section only if there are json parameters
  const jsonSection = jsonDefs.length > 0
    ? `json {
            required {
                ${jsonDefs.join('\n                ')}
            }
        }
        `
    : ''

  // Build headers section only if there are headers
  const headersSection = headerDefs.length > 0 && !options.hideHeaders
    ? `headers {
            required {
                ${headerDefs.join('\n                ')}
            }
        }
        `
    : ''

  // Build cookies section only if there are cookies
  const cookiesSection = cookieDefs.length > 0 && !options.hideCookies
    ? `cookies {
            url: ${rustStr(url)},
            required {
                ${cookieDefs.join('\n                ')}
            }
        }
        `
    : ''

  // Clean up trailing whitespace and newlines
  const sections = [pathSection, querySection, jsonSection, headersSection, cookiesSection]
    .filter(s => s.trim().length > 0)
    .join('')
    .replace(/\n\s*$/, '')

  const attachAttribute = options.addAttach ? '#[attach(Client)]\n    ' : ''

  return `declare_endpoint! {
    ${attachAttribute}pub ${endpointName} => serde_json::Value {
        url: ${rustStr(url)},
        method: reqwest::Method::${rustMethod},

        ${sections}
    }
}`
}

// Settings management with cookie persistence
function getSettings () {
  const defaultSettings = {
    addAttach: false,
    hideCookies: false,
    hideHeaders: false
  }

  try {
    const saved = document.cookie
      .split('; ')
      .find(row => row.startsWith('curlconverter_settings='))

    if (saved) {
      const decoded = decodeURIComponent(saved.split('=')[1])
      return { ...defaultSettings, ...JSON.parse(decoded) }
    }
  } catch (e) {
    console.warn('Failed to load settings:', e)
  }

  return defaultSettings
}

function saveSettings (settings) {
  try {
    const encoded = encodeURIComponent(JSON.stringify(settings))
    document.cookie = `curlconverter_settings=${encoded}; max-age=${365 * 24 * 60 * 60}; path=/`
  } catch (e) {
    console.warn('Failed to save settings:', e)
  }
}

// The custom converter for your Rust macro endpoint (required version)
const toCustomWarn = (curlCommand, warnings = []) => {
  const [harJSONString] = curlconverter.toHarStringWarn(curlCommand, warnings)
  try {
    const har = JSON.parse(harJSONString)
    const entry = har.log.entries[0]
    const settings = getSettings()

    const endpointName = 'Root'

    const macro = harToRustEndpointMacro(entry.request, endpointName, settings)
    return [macro, []]
  } catch (e) {
    return [`// Failed to generate endpoint: ${e.message}`, warnings]
  }
}

// The custom converter for your Rust macro endpoint (defaults version)
const toCustomDefaultsWarn = (curlCommand, warnings = []) => {
  const [harJSONString] = curlconverter.toHarStringWarn(curlCommand, warnings)
  try {
    const har = JSON.parse(harJSONString)
    const entry = har.log.entries[0]
    const settings = getSettings()

    const endpointName = 'Root'

    const macro = harToRustEndpointMacroDefaults(entry.request, endpointName, settings)
    return [macro, []]
  } catch (e) {
    return [`// Failed to generate endpoint: ${e.message}`, warnings]
  }
}

export { toCustomWarn, toCustomDefaultsWarn, getSettings, saveSettings }

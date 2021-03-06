var ksqlServer = 'http://52.79.47.1:8188';

var xhr = new XMLHttpRequest();

var renderFunction = renderTabular;
var streamedResponse = false;
var fromBeginning = false;
var rawResponseBody = '';
var sqlExpressionPrev = '';

String.prototype.replaceAll = function (search, replacement) {
  var target = this;
  return target.split(search).join(replacement);
};

function runCommand() {
  var sqlExpression = editor.getValue();
  var upperSqlExpression = sqlExpression.toUpperCase();
  var sqlExpression = editor.getValue();
  if (upperSqlExpression.startsWith("SELECT") || upperSqlExpression.startsWith("PRINT")) {
    streamedResponse = true;
    // execute KSQL interactive streaming query
    sendRequest("/query", sqlExpression)
  } else {
    // execute KSQL statement
    streamedResponse = false;
    sendRequest("/ksql", sqlExpression)
  }
}

function displayServerVersion() {
  xhr.onreadystatechange = function () {
    if (this.readyState == 4 && this.status == 200) {
      var serverVersionResponse = JSON.parse(this.responseText);
      document.getElementById("copyright").innerHTML = "ksqlDB 서버 v" + serverVersionResponse.KsqlServerInfo.version
    } else {
      document.getElementById("copyright").innerHTML = "ksqlDB 서버에 연결되어 있지 않습니다."
    }
  };
  xhr.open("GET", ksqlServer + "/info", true);
  xhr.send();
}

function sendRequest(resource, sqlExpression) {
  fromBeginning = false;
  sqlExpressionPrev = sqlExpression;
  if (resource == '/ksql') {  // run command by button
    streamedResponse = false;
  }

  xhr.abort();

  var properties = getProperties();

  xhr.onreadystatechange = function () {
    if (xhr.response !== '' && ((xhr.readyState === 3 && streamedResponse) || xhr.readyState === 4)) {
      if (properties['auto.offset.reset']) {
        if (properties['auto.offset.reset'] == 'earliest') {
          fromBeginning = true;
        }
      }
      if (sqlExpressionPrev.indexOf('PRINT') == 0 && sqlExpressionPrev.indexOf('FROM BEGINNING') != -1) {
        fromBeginning = true;
      }
      rawResponseBody = xhr.response.trim();
      renderResponse();
    }
    if (xhr.readyState === 4 || xhr.readyState === 0) {
      document.getElementById('request_loading').hidden = true;
      document.getElementById('cancel_request').hidden = true;
    }
  };

  var data = JSON.stringify({
    'ksql': sqlExpression,
    'streamsProperties': properties
  });

  document.getElementById('cancel_request').hidden = false;
  document.getElementById('request_loading').hidden = false;
  xhr.open('POST', ksqlServer + resource);
  xhr.setRequestHeader('Content-Type', 'application/vnd.ksql.v1+json; charset=utf-8');
  xhr.send(data);
}

function cancelRequest() {
  //var responseElement = document.getElementById('response');
  //var response = responseElement.innerHTML;
  xhr.abort();
  //responseElement.innerHTML = response;
}

function renderResponse() {
  var renderedBody = '';
  var count = 1;
  if (streamedResponse) {
    // Used to try to report JSON parsing errors to the user, but
    // since printed topics don't have a consistent format, just
    // have to assume that any parsing error is for that reason and
    // we can just stick with the raw message body for the output
    var splitBody = rawResponseBody.split('\n');
    for (var i = 0; i < splitBody.length; i++) {
      var line = splitBody[i].trim();
      if (line !== '') {
        try {
          // response format for ksqlDB (2020.10.10)
          if (line.substring(0, 1) === '[') {
            line = line.substring(1, line.length);
          }
          if (line.substring(line.length - 1) === ',') {
            line = line.substring(0, line.length - 1);
          }

          var parsedJson = JSON.parse(line);
          var renderResult = renderFunction(parsedJson);
          renderedBody += renderResult;
          count = count + (renderResult.match(/\n/g) || '').length + 1;
        } catch (SyntaxError) {
          renderedBody += line;
          count = count + 1;
        }
        renderedBody += '\n';
      }
      if (count > 1000) {
        break;
      }
    }
    count = count + 1;
  } else {
    try {
      var parsedJson = JSON.parse(rawResponseBody);
      renderedBody = renderFunction(parsedJson);

      if (renderedBody == "") {
        updateFormat(renderPrettyJson)
        renderFunction = renderTabular;
        return;
      }

    } catch (SyntaxError) {
      console.log('Error parsing response JSON:' + SyntaxError.message);
      console.log(SyntaxError.stack);
      renderedBody = rawResponseBody;
    }
  }
  response.setValue(renderedBody);
  response.gotoLine(count);

  if (count > 1000 && streamedResponse && xhr.status == 200) {
    cancelRequest();
    if (fromBeginning) {
      response.setValue(renderedBody + '\n' + 'This query can only show 1000 lines.');
      response.gotoLine(count + 1);
    } else {
      sendRequest("/query", sqlExpressionPrev);
    }
  }
}

function renderTabular(parsedBody) {
  response.session.setMode("ace/mode/json");

  if (Array.isArray(parsedBody)) {
    // The response is a list of statement responses
    var result = [];
    for (var i = 0; i < parsedBody.length; i++) {
      result.push(renderTabularStatement(parsedBody[i]));
    }
    return result.join('\n\n');
  } else if (parsedBody instanceof Object) {
    // The response is either an error or a streamed row
    var errorMessage = parsedBody.message || parsedBody.errorMessage;
    if (errorMessage) {
      return errorMessage;
    } else if (parsedBody.row) {
      var result = [];
      var columns = parsedBody.row.columns;
      for (var i = 0; i < columns.length; i++) {
        // TODO: Figure out how to handle arrays/maps here...
        if (columns[i] == null) {
          columns[i] = 'null';
        }
        result.push(columns[i].toString().replace(/\n/gi, '\\n'));
      }
      return ' ' + result.join(' | ') + ' ';
    } else if (parsedBody.header) {
      var res = parsedBody.header.schema.replace(/,/gi, ' |');
      res += '\n' + Array(res.length + 1).join('-');
      return res;
    } else {
      throw SyntaxError;
    }
  } else {
    throw SyntaxError;
  }
}

function getObjectProperties(object) {
  var rowValues = [];

  for (var property in object) {
    if (object[property].value == null) {
      object[property].value = "";
    }
    rowValues.push([object[property].name, object[property].value]);
  }
  return rowValues;
}

function getAutoColsAndRows(object) {
  var cols = [];

  if (object[0] != null) {
    Object.keys(object[0]).forEach(function (key) {
      cols.push(upperCaseFirst(key));
    });
  } else {
    return [["Message"], [["No Data"]]];
  }

  var rows = [];

  object.forEach(function (item) {
    var row = []
    Object.values(item).forEach(function (value) {
      // stringify the value
      if (isPrimitive(value)) {
        value = value + "";
      } else {
        value = JSON.stringify(value);
      }

      row.push(value);
    });
    rows.push(row);
  })
  return [cols, rows];
}

function renderTabularStatement(statementResponse) {
  var autoColAndRows;
  var columnHeaders, rowValues;

  if (statementResponse['@type'] == 'properties') {
    columnHeaders = ['Property', 'Value'];
    rowValues = getObjectProperties(statementResponse.properties);
  } else if (statementResponse['@type'] == 'kafka_topics') {
    autoColAndRows = getAutoColsAndRows(statementResponse.topics)
  } else if (statementResponse['@type'] == 'streams') {
    autoColAndRows = getAutoColsAndRows(statementResponse.streams)
  } else if (statementResponse['@type'] == 'tables') {
    autoColAndRows = getAutoColsAndRows(statementResponse.tables)
  } else if (statementResponse['@type'] == 'queries') {
    autoColAndRows = getAutoColsAndRows(statementResponse.queries)
  } else if (statementResponse['@type'] == 'function_names') {
    autoColAndRows = getAutoColsAndRows(statementResponse.functions)
  } else if (statementResponse['@type'] == 'sourceDescription') {
    return renderPrettyJson(statementResponse)
  } else if (statementResponse['@type'] == 'queryDescription') {
    return renderPrettyJson(statementResponse)
  } else if (statementResponse['@type'] == 'currentStatus') {
    return renderPrettyJson(statementResponse)
  } else if (statementResponse.setProperty) {
    var innerBody = statementResponse.setProperty;
    columnHeaders = ['Property', 'Prior Value', 'New Value'];
    rowValues = [
      [innerBody.property, innerBody.oldValue, innerBody.newValue]
    ];
  } else {
    throw SyntaxError;
  }
  if (autoColAndRows != null) {
    return renderTable(autoColAndRows[0], autoColAndRows[1]);
  } else {
    return renderTable(columnHeaders, rowValues);
  }
}

function renderTable(columnHeaders, rowValues) {
  var lengths = [];

  columnHeaders.forEach(function (item) {
    lengths.push(item.length);
  })

  if (!rowValues || rowValues.length === 0) {
    return renderTableRow(columnHeaders, lengths);
  }

  rowValues.forEach(function (row) {
    row.forEach(function (item) {
      for (var j = 0; j < row.length; j++) {
        lengths[j] = Math.max(lengths[j], row[j].length);
      }
    })
  })

  var lengthsSum = lengths[0] + 2;
  for (var i = 1; i < lengths.length; i++) {
    lengthsSum += lengths[i] + 3;
  }

  var result = [
    renderTableRow(columnHeaders, lengths),
    Array(lengthsSum + 1).join('-')
  ];
  for (var i = 0; i < rowValues.length; i++) {
    result.push(renderTableRow(rowValues[i], lengths));
  }

  return result.join('\n');
}

function renderTableRow(values, lengths) {
  var result = [];
  for (var i = 0; i < values.length; i++) {
    result.push(pad(values[i], lengths[i] || 0));
  }
  return ' ' + result.join(' | ') + ' ';
}

function pad(str, len) {
  if (str.length >= len) {
    return str;
  }
  var pad = Array(len - str.length + 1).join(' ');
  return str + pad;
}

function renderPrettyJson(parsedBody) {
  response.session.setMode("ace/mode/json");
  return JSON.stringify(parsedBody, null, 2);
}

function renderCompactJson(parsedBody) {
  response.session.setMode("ace/mode/json");
  return JSON.stringify(parsedBody);
}

function updateFormat(newRenderFunction) {
  renderFunction = newRenderFunction;
  if (rawResponseBody !== '') {
    renderResponse();
  }
}

function upperCaseFirst(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

function isPrimitive(test) {
  return (test !== Object(test));
}

function initProperty() {
  addNewProperty('auto.offset.reset', 'latest');
}

function addNewProperty(propKey, propValue) {
  var propertiesElement = document.getElementById('properties');
  if (propertiesElement.childElementCount == 5) {
    return;
  }

  var key = document.createElement('input');
  key.type = 'text';
  key.placeholder = '키';
  key.classList.add('property-key');

  var value = document.createElement('input');
  value.type = 'text';
  value.placeholder = '값';
  value.classList.add('property-value');

  if (propKey !== '') {
    key.value = propKey;
  }
  if (propValue !== '') {
    value.value = propValue;
  }

  var deleteButton = document.createElement('button');
  deleteButton.appendChild(document.createTextNode('X'));

  var propertySpan = document.createElement('span');
  propertySpan.classList.add('property');

  propertySpan.appendChild(key);
  propertySpan.appendChild(document.createTextNode(' '));
  propertySpan.appendChild(document.createTextNode('='));
  propertySpan.appendChild(document.createTextNode(' '));
  propertySpan.appendChild(value);
  propertySpan.appendChild(document.createTextNode(' '));
  propertySpan.appendChild(deleteButton);

  var propertyDiv = document.createElement('div');
  propertyDiv.classList.add('property');

  propertyDiv.appendChild(propertySpan);

  propertiesElement.appendChild(propertyDiv);

  deleteButton.onclick = function () {
    propertiesElement.removeChild(propertyDiv);
  }
}

function getProperties() {
  var properties = {};
  var key, value;
  var propertyElements = document.getElementById('properties').children;
  for (var i = 0; i < propertyElements.length; i++) {
    var propertyDiv = propertyElements[i];
    if (!propertyDiv.classList.contains('property')) {
      continue;
    }
    var propertyDivChildren = propertyDiv.children;
    for (var j = 0; j < propertyDivChildren.length; j++) {
      var propertySpan = propertyDivChildren[j];
      if (!propertySpan.classList.contains('property')) {
        continue;
      }
      var propertySpanChildren = propertySpan.children;
      for (var k = 0; k < propertySpanChildren.length; k++) {
        var propertyInput = propertySpanChildren[k];
        if (propertyInput.classList.contains('property-key')) {
          key = propertyInput.value.trim();
        } else if (propertyInput.classList.contains('property-value')) {
          value = propertyInput.value.trim();
        }
      }
    }
    if (key === '') {
      continue;
    }
    properties[key] = value;
  }
  return properties;
}

window.onload = initProperty;

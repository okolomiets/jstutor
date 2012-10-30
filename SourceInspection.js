var EventEmitter = require('events').EventEmitter
  , Debugger = require('./lib/debugger.js')
  , util = require('util')
  , ReferenceParser = require('./ReferenceParser.js');

// Output documentation:
// https://github.com/pgbovine/OnlinePythonTutor/blob/master/v3/docs/opt-trace-format.md

var SourceInspection = function(filename, port) {
  EventEmitter.call(this);
  var traces = [];
  var self = this;
  var userScriptRef = null;
  var excludingVars =
      {'__dirname': 1, '__filename': 1, 'exports': 1,
        'module': 1, 'require': 1};

  var dbgr = Debugger.attachDebugger(port);
  dbgr.on('close', function() {
    self.emit('done', traces);
    console.log('User Dbg: Closed!');
  });

  dbgr.on('error', function(e) { console.log('User Dbg: Error! ', e); });
  dbgr.on('exception', function(e) { console.log('User Dbg: Exception!: ', e); });
  dbgr.on('connect', function() { console.log('User Dbg: Connected!'); });
  dbgr.on('break', function(obj) {
    // first stop when the code reach first line of user's code
    // request backtrace
    // - if not in user source -> step out
    // - otherwise step in
    // inspect obj.body.script.name
    var scriptPath = obj.body.script.name;
    console.log('Break ', scriptPath, ': ', obj.body.sourceLine);
    if (!isUserScript(scriptPath)) {
      // if it is not user_program => step out
      dbgr.request('continue', { arguments: { stepaction: 'out' } });
      return;
    }

    // extract current state of the code: variables, closures
    dbgr.request('backtrace', { arguments: { } }, function(resp) {
      // all recorded data are for the source only.
      // by default of V8debugger, there is maximum 10 stack frames.
      // that should do it for now
      extractSingleStep(resp, function() {
        dbgr.request('continue', { arguments: { stepaction: 'in' } });
      });
    });
  });

  var extractSingleStep = function(btmsg, callback) {
    // each frame extract: local variable & argument
    // need to fetch the value by reference
    // each frame = 1 stack level
    // TODO: extract scope information of a frame
    var frames = btmsg.body.frames;
    var stepData = {};
    var handles = [];
    var refValues = {};
    var variables = {};

    // placeholder. event can ben step_line or return
    stepData['event'] = 'step_line';
    stepData['func_name'] = frames[0].func;
    stepData['line'] = frames[0].line;

    var processVar = function(v) {
      variables[v.name] = v;
      handles.push(v.value.ref);
    };

    for (var i = btmsg.body.toFrame - 1; i >= 0; i--) {
      var frame = frames[i];
      console.log(frame);

      var filepath = extractFileNameFromSource(frame.text);
      if (!isUserScript(filepath)) {
        continue;
      }

      console.log('-------------');
      if (frame.locals) {
        for (var j = 0; j < frame.locals.length; j++) {
          processVar(frame.locals[j]);
        }
      }

      console.log('+++++++++++++++');
      if (frame.arguments) {
        for (var j = 0; j < frame.arguments.length; j++) {
          var v = frame.arguments[j];
          if (!excludingVars[v.name]) {
            processVar(v);
          }
        }
      }
    }

    var postProcessing = function() {
      // parse heap & global / local values to fit the output format by OPT
      var renderResult = ReferenceParser.renderOPTFormat(refValues, variables);
      stepData['variables'] = renderResult.variableDict;
      stepData['heap'] = renderResult.heap;
      traces.push(stepData);
      // step forward
      callback();
    }

    var processLookup = function(resp) {
      var refs = [];
      for (var refId in resp.body) {
        refValues[refId] = resp.body[refId];
        var innerRefs = ReferenceParser.extractRef(resp.body[refId]);
        refs = refs.concat(innerRefs);
      }
      console.log(refs, refs.length);
      if (refs.length) {
        // repeat the lookup, because the refence can be nested.
        console.log('inner refs');
        dbgr.request('lookup', { arguments: { handles: refs } }, processLookup);
      } else {
        // cleanup and step forward.
        console.log('done looking up');
        postProcessing();
      }
    }

    // fetching actual value of variables
    dbgr.request('lookup', { arguments: { handles: handles } }, processLookup);
  };

  // return true if the script in scriptPath is user's script
  var isUserScript = function(scriptPath) {
    var paths = scriptPath.split('/');
    return (paths[paths.length - 1] == filename);
  };

  var extractFileNameFromSource = function(frameText) {
    var pieces = frameText.split(' ');
    // 7 = magic number by observing the data
    var path = pieces[pieces.length - 7];
    return path;
  };
};

util.inherits(SourceInspection, EventEmitter);

module.exports = SourceInspection;

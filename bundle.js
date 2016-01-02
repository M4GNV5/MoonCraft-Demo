require=(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
var base = require("./lib/base.js");
var types = require("./lib/types.js");
var nextName = require("./lib/naming.js");
var optimize = require("./lib/optimize.js");
var scope = require("./lib/Scope.js");

var currRet = [];
var breakLabel;

var compile = function(ast, path, isMain)
{
    for(var i = 0; i < ast.body.length; i++)
    {
        compileStatement(ast.body[i]);
    }

    optimize.garbageCollect();
};
compile.scope = scope;
module.exports = compile;

function throwError(message, loc)
{
    var locStr = " at line ";
    if(loc.start.line == loc.end.line)
        locStr += loc.start.line + " column " + loc.start.column + " in " + compile.file;
    else
        locStr += loc.start.line + " column " + loc.start.column + " to line " + loc.end.line + " column " + loc.end.column + " in " + compile.file;

    throw message + locStr;
}

function compileBody(body, end, label, bodyScope)
{
    label = label || nextName("body");
    base.addFunction(label, function()
    {
        var _body = optimize.removeDeadEnds(body);

        scope.increase(bodyScope);
        compileStatementList(_body);
        optimize.garbageCollect();
        scope.decrease();

        if(end && body == _body)
            end();
    });
    return label;
}

function compileStatementList(stmts)
{
    stmts = optimize.removeDeadEnds(stmts);
    for(var i = 0; i < stmts.length; i++)
    {
        compileStatement(stmts[i]);
    }
}

function compileStatement(stmt)
{
    var type = stmt.type;

    if(!statements.hasOwnProperty(type))
        throwError("unknown statement type " + type, stmt.loc);

    return statements[type](stmt);
}

function compileExpression(expr, supportArrays)
{
    var type = expr.type;

    if(!expressions.hasOwnProperty(type))
        throwError("unknown expression type " + type, expr.loc);

    var val = expressions[type](expr);

    if(!supportArrays && val instanceof Array)
        return val[0];
    else
        return val;
}

function checkTypeMismatch(left, right, loc)
{
    if(!typeMatch(left, right))
        throwError("Incompatible types " + left.constructor.name + " and " + right.constructor.name, loc);
}

function typeMatch(left, right)
{
    var compatibleTypes = [
		[types.Integer, types.Float, types.Score, (0).constructor, types.Boolean, (true).constructor], //int, float
        [types.Table, Array], //table, array
		[types.String, ("").constructor] //string
	];

	if(left.constructor == right.constructor)
		return true;

	for(var i = 0; i < compatibleTypes.length; i++)
	{
		if(compatibleTypes[i].indexOf(left.constructor) != -1 && compatibleTypes[i].indexOf(right.constructor) != -1)
		{
			return true;
		}
	}

	return false;
}

function checkOperator(val, op, opLabel, loc)
{
    if(typeof val[op] != "function")
        throwError("Type " + val.constructor.name + " does not support operator " + opLabel, loc);
}

function trueify(val, loc)
{
    return boolify(val, true, loc);
}
function falseify(val, loc)
{
    return boolify(val, false, loc);
}

function boolify(val, type, loc)
{
    var label = nextName("trueify");
    if(typeof val == "string")
    {
        if(type)
        {
            return val;
        }
        else
        {
            base.addLabel(label);
            command(val);
            return "testforblock %" + label + ":diff% minecraft:chain_command_block -1 {SuccessCount:0}";
        }
    }
    else if(typeof val != "object")
    {
        val = !val;
        if(type)
            val = !val;
        return val ? "testfor @e" : "falsy: " + val.toString();
    }
    else if(val instanceof types.Boolean)
    {
        return val.isExact(type);
    }
    else if(val instanceof types.String)
    {
        var cmd = val.isExact("");

        if(type)
        {
            base.addLabel(label);
            base.command(cmd);
            return "testforblock %" + label + ":diff% minecraft:chain_command_block -1 {SuccessCount:0}";
        }
        else
        {
            return cmd;
        }
    }
    else if(val.toInteger)
    {
        var fn = val.isExact ? val.isExact : val.toInteger().isExact;
        var cmd = fn.call(val, 0);

        if(type)
        {
            base.addLabel(label);
            base.command(cmd);
            return "testforblock %" + label + ":diff% minecraft:chain_command_block -1 {SuccessCount:0}";
        }
        else
        {
            return cmd;
        }
    }
    else
    {
        throwError("cannot boolify " + val.constructor.name, loc);
    }
}

function createRuntimeVar(val, name)
{
    if(typeof val == "boolean" || val.constructor == types.Boolean)
        return new types.Boolean(val, name);
    else if((typeof val == "number" && Math.round(val) == val) || val.constructor == types.Integer)
        return new types.Integer(val, name);
    else if(typeof val == "number" || val.constructor == types.Float)
        return new types.Float(val, name);
    else if(typeof val == "string" && val[0] == "/")
        return commandToBool(val, name);
    else if(typeof val == "string" || val.constructor == types.String)
        return new types.String(val, name);
    else if(val instanceof types.Score)
        return val;
    else if(val instanceof Array || val instanceof types.Table)
        return new types.Table(val, name);
}

function commandToBool(cmd, name)
{
    var val = new types.Boolean(false, name);
    command(cmd);
    val.set(true, true);
    return val;
}

function assignStatement(stmt, scopeGet, scopeSet)
{
    function assign(left, newVal, optimized)
    {
        var key;
        var oldVal;
        if(left.type == "Identifier")
        {
            key = left.name;
            oldVal = scopeGet(key);
        }
        else if(left.type == "IndexExpression")
        {
            var index = compileExpression(left.index);
            var base = compileExpression(left.base);

            base.setAt(index, newVal);
            return;
        }
        else
        {
            oldVal = compileExpression(left);
        }

        if(!oldVal && key)
        {
            var name = nextName(key);
            oldVal = createRuntimeVar(newVal, name);
            scopeSet(key, oldVal);
        }
        else if(optimized)
        {
            var ops = {
                "+": "add",
                "-": "remove",
                "*": "multiplicate",
                "/": "divide",
                "%": "mod"
            };
            oldVal[ops[optimized.operator]](newVal);
        }
        else if(oldVal)
        {
            checkTypeMismatch(oldVal, newVal, stmt.loc);
            oldVal.set(newVal);
        }
        else
        {
            throwError("Invalid assign statement", stmt.loc);
        }
    }


    var rest;
    for(var i = 0; i < stmt.variables.length && i < stmt.init.length; i++)
    {
        var left = stmt.variables[i];
        var right = stmt.init[i];

        var optimized = optimize.selfAssign(left, right);

        var rightExpr = optimized ? optimized.argument : right;
        var newVal = compileExpression(rightExpr, true);

        if(newVal instanceof Array)
        {
            rest = newVal.slice(1);
            newVal = newVal[0];
        }
        else
        {
            rest = [];
        }

        assign(left, newVal, optimized);
    }

    for(var i = 0; i < rest.length; i++)
    {
        var left = stmt.variables[i + stmt.init.length];
        if(!left)
            return;

        var newVal = rest[i];

        assign(left, newVal);
    }
}

function resolveType(name, loc)
{
    var alias = {
        "Boolean": ["bool", "boolean"],
        "Integer": ["int", "i32", "integer", "number"],
        "Float": ["float"],
        "String": ["string"],
        "Table": ["table", "array"]
    };

    name = name.toLowerCase();
    for(var key in alias)
    {
        if(alias[key].indexOf(name) != -1)
            return types[key];
    }

    throwError("Unknown type " + name, loc);
}

var statements = {};
var expressions = {};

statements["AssignmentStatement"] = function(stmt)
{
    assignStatement(stmt, scope.get.bind(scope), scope.setGlobal.bind(scope));
};

statements["LocalStatement"] = function(stmt)
{
    assignStatement(stmt, function(key)
    {
        return scope.current()[key];
    }, scope.set.bind(scope));
};

statements["FunctionDeclaration"] = function(stmt)
{
    var funcName = stmt.identifier.name;
    var bodyName;

    scope.increase();
    var funcStack = scope.save();
    scope.decrease();

    var typeSignature = [];
    var returnSignature = false;
    var argNames = [];

    var func = function()
    {
        if(stmt.parameters.length != arguments.length)
        {
            throwError("function {0} requires {1} arguments not {2}"
                .format(funcName, stmt.parameters.length, arguments.length), stmt.loc);
        }

        var _stack = scope.save();
        scope.load(funcStack);
        for(var i = 0; i < stmt.parameters.length; i++)
        {
            var name;
            if(stmt.parameters[i].type == "TypedIdentifier")
                name = stmt.parameters[i].identifier.name;
            else
                name = stmt.parameters[i].name;

            var val = arguments[i];

            if(typeSignature[i] && !typeMatch(typeSignature[i], val))
            {
                throwError("function {0} requires argument {1} to be {2} not {3}"
                    .format(funcName, i, typeSignature[i].constructor.name, val.constructor.name), stmt.loc);
            }

            if(!typeSignature[i])
            {
                argNames[i] = nextName(name);
                val = createRuntimeVar(val, argNames[i])
                typeSignature[i] = val;
                scope.set(name, val);
            }
            else
            {
                scope.get(name).set(val);
            }
        }
        scope.load(_stack);

        if(!bodyName)
        {
            bodyName = funcName;

            var _currRet = currRet;

            currRet = returnSignature;
            scope.load(funcStack);
            compileBody(stmt.body, base.ret, funcName);
            scope.load(_stack);
            returnSignature = currRet;


            currRet = _currRet;

            func.funcName = funcName;
            func.typeSignature = typeSignature;
            func.returnSignature = returnSignature;
        }


        base.rjump(bodyName);

        return returnSignature;
    };

    var _stack = scope.save();
    scope.load(funcStack);

    var allTyped = true;
    for(var i = 0; i < stmt.parameters.length; i++)
    {
        var param = stmt.parameters[i];
        if(param.type == "TypedIdentifier")
        {
            var name = param.identifier.name;
            var ctor = resolveType(param.varType.name, param.varType.loc);

            typeSignature[i] = new ctor(0, nextName(name), true);
            scope.set(name, typeSignature[i]);
        }
        else
        {
            allTyped = false;
            continue;
        }
    }
    if(allTyped)
        func.typeSignature = typeSignature;

    if(stmt.returnTypes.length == 1 && stmt.returnTypes[0].name == "void")
    {
        returnSignature = [];
        func.returnSignature = returnSignature;
    }
    else if(stmt.returnTypes.length > 0)
    {
        returnSignature = [];
        for(var i = 0; i < stmt.returnTypes.length; i++)
        {
            var typeName = stmt.returnTypes[i].name;
            var ctor = resolveType(typeName, stmt.returnTypes[i].loc);

            var name = nextName("ret" + i + typeName);
            returnSignature[i] = new ctor(0, name, true);
        }
        func.returnSignature = returnSignature;
    }
    else
    {
        allTyped = false;
    }

    if(allTyped)
    {
        bodyName = funcName;

        var _currRet = currRet;

        currRet = returnSignature;
        compileBody(stmt.body, base.ret, funcName);
        currRet = _currRet;

        func.funcName = funcName;
    }

    scope.load(_stack);

    if(stmt.isLocal)
        scope.set(funcName, func);
    else
        scope.setGlobal(funcName, func);
};

statements["ReturnStatement"] = function(stmt)
{
    var args = [];
    for(var i = 0; i < stmt.arguments.length; i++)
    {
        args[i] = compileExpression(stmt.arguments[i]);
    }

    if(currRet)
    {
        if(stmt.arguments.length != currRet.length)
            throwError("cannot return a different count of arguments than before", stmt.loc);

        for(var i = 0; i < currRet.length && i < args.length; i++)
        {
            if(!typeMatch(currRet[i], args[i]))
                throwError("cannot return a different type signature than before", stmt.arguments[i].loc);

            currRet[i].set(args[i]);
        }
    }
    else
    {
        currRet = [];
        for(var i = 0; i < args.length; i++)
        {
            var name = nextName("ret" + i + args[i].constructor.name);
            currRet[i] = createRuntimeVar(args[i], name);
        }
    }

    base.ret();
    block(options.splitterBlock);
};

statements["BreakStatement"] = function(stmt)
{
    if(!breakLabel)
        throwError("Invalid break statement", stmt.loc);

    base.jump(breakLabel);
    block(options.splitterBlock);
};

statements["CallStatement"] = function(stmt)
{
    compileExpression(stmt.expression);
};

statements["IfStatement"] = function(stmt)
{
    var clauses = stmt.clauses;

    var endLabel = nextName("ifend");

    var hasSucess = new types.Boolean(false, nextName("ifsuccess"));

    var hasElse = false;

    for(var i = 0; i < clauses.length; i++)
    {
        var type = clauses[i].type;

        if(type == "IfClause")
        {
            var expr = compileExpression(clauses[i].condition);
            var bodyLabel = compileBody(clauses[i].body, base.jump.bind(base, endLabel));

            command(trueify(expr, clauses[i].condition.loc));

            base.jump(bodyLabel, true);
            hasSucess.set(true, true);
        }
        else if(type == "ElseifClause")
        {
            var expr = compileExpression(clauses[i].condition);
            var bodyLabel = compileBody(clauses[i].body, base.jump.bind(base, endLabel));

            var cmd = trueify(expr, clauses[i].condition.loc);

            command(hasSucess.isExact(false));
            command(cmd, true);

            base.jump(bodyLabel, true);
            hasSucess.set(true, true);
        }
        else if(type == "ElseClause")
        {
            var bodyLabel = compileBody(clauses[i].body, base.jump.bind(base, endLabel));

            command(hasSucess.isExact(false));
            base.jump(bodyLabel, true);

            hasElse = true;
        }
        else
        {
            throwError("unsupported clause " + clauses[i].type, stmt.loc);
        }
    }

    if(!hasElse)
    {
        command(hasSucess.isExact(false));
        base.jump(endLabel, true);
    }

    block(options.splitterBlock);
    base.addLabel(endLabel);
};

statements["ForNumericStatement"] = function(stmt)
{
    var iteratorName = stmt.variable.name;
    var start = compileExpression(stmt.start);
    var end = compileExpression(stmt.end);

    var iterator = createRuntimeVar(start, nextName(iteratorName));
    var step = stmt.step ? compileExpression(stmt.step) : 1;

    var checkCondition;
    if(typeof step == "number" && typeof end == "number")
    {
        checkCondition = function()
        {
            if(step > 0)
                return iterator.isBetween(undefined, end);
            else if(step <= 0)
                return iterator.isBetween(end, undefined);
        };
    }
    else if(typeof step == "number" && typeof end == "object")
    {
        checkCondition = function()
        {
            checkOperator(end, "clone", "clone", stmt.end.loc);
            var clone = end.clone();
            clone.remove(iterator);
            if(step > 0)
                return clone.isBetween(0, undefined);
            else if(step <= 0)
                return clone.isBetween(undefined, 0);
        };
    }
    else if(typeof step == "object" && typeof end == "number")
    {
        checkCondition = function()
        {
            var success = new types.Boolean(false, "forsuccess");

            command(step.isBetweenEx(0, undefined));
            command(iterator.isBetween(undefined, end), true);
            success.set(true, true);

            command(step.isBetween(undefined, 0));
            command(iterator.isBetween(end, undefined), true);
            success.set(true, true);

            return success.isExact(true);
        };
    }
    else if(typeof step == "object" && typeof end == "object")
    {
        checkCondition = function()
        {
            var success = new types.Boolean(false, "forsuccess");

            checkOperator(end, "clone", "clone", stmt.end.loc);
            var clone = end.clone();
            clone.remove(iterator);

            command(step.isBetweenEx(0, undefined));
            command(clone.isBetween(0, undefined), true);
            success.set(true, true);

            command(step.isBetween(undefined, 0));
            command(clone.isBetween(undefined, 0), true);
            success.set(true, true);

            return success.isExact(true);
        };
    }

    scope.increase();
    scope.set(iteratorName, iterator);
    var forScope = scope.decrease();

    var bodyLabel = nextName("for");
    var checkLabel = bodyLabel + "check";
    var endLabel = bodyLabel + "end";

    var _breakLabel = breakLabel;
    breakLabel = endLabel;

    base.jump(checkLabel);
    block(options.splitterBlock);

    base.addFunction(bodyLabel, function()
    {
        scope.increase(forScope);

        compileStatementList(stmt.body);

        if(typeof step == "object")
            iterator.add(step);
        else if(step < 0)
            iterator.remove(-step);
        else if(step > 0)
            iterator.add(step);

        base.addLabel(checkLabel);
        command(checkCondition());
        base.jump(bodyLabel, true);
        command("testforblock %-2:diff% minecraft:chain_command_block -1 {SuccessCount:0}");
        base.jump(endLabel, true);

        scope.decrease();
    });

    base.addLabel(endLabel);
    scope.increase(forScope);
    optimize.garbageCollect();
    scope.decrease();

    breakLabel = _breakLabel;
};

statements["DoStatement"] = function(stmt)
{
    scope.increase();
    compileStatementList(stmt.body);
    optimize.garbageCollect();
    scope.decrease();
};

statements["WhileStatement"] = function(stmt)
{
    var bodyLabel = nextName("while");
    var checkLabel = bodyLabel + "check";
    var endLabel = bodyLabel + "end";

    var _breakLabel = breakLabel;
    breakLabel = endLabel;

    base.jump(checkLabel);
    block(options.splitterBlock);

    scope.increase();
    var whileScope = scope.decrease();

    base.addFunction(bodyLabel, function()
    {
        scope.increase(whileScope);

        compileStatementList(stmt.body);

        base.addLabel(checkLabel);
        var condition = compileExpression(stmt.condition);
        command(trueify(condition, stmt.condition.loc));
        base.jump(bodyLabel, true);

        command("testforblock %-2:diff% minecraft:chain_command_block -1 {SuccessCount:0}");
        base.jump(endLabel, true);

        scope.decrease();
    });

    base.addLabel(endLabel);
    scope.increase(whileScope);
    optimize.garbageCollect();
    scope.decrease();

    breakLabel = _breakLabel;
};

statements["RepeatStatement"] = function(stmt)
{
    var bodyLabel = nextName("repeat");
    var endLabel = bodyLabel + "end";

    var _breakLabel = breakLabel;
    breakLabel = endLabel;

    base.addLabel(bodyLabel);

    scope.increase();
    compileStatementList(stmt.body);

    var condition = compileExpression(stmt.condition);
    command(falseify(condition, stmt.condition.loc));
    base.jump(bodyLabel, true);

    command("testforblock %-2:diff% minecraft:chain_command_block -1 {SuccessCount:0}");
    base.jump(endLabel, true);

    block(options.splitterBlock);
    base.addLabel(endLabel);
    optimize.garbageCollect();
    scope.decrease();

    breakLabel = _breakLabel;
};

expressions["TableConstructorExpression"] = function(expr)
{
    var args = [];
    for(var i = 0; i < expr.fields.length; i++)
    {
        if(expr.fields[i].type != "TableValue")
            throwError("Unsupported table field type", field.loc);

        args[i] = compileExpression(expr.fields[i].value);
    }

    return [args];
}

expressions["IndexExpression"] = function(expr)
{
    var base = compileExpression(expr.base);

    checkOperator(base, "get", "[index]", expr.base.loc);

    var index = compileExpression(expr.index);

    return base.get(index);
}

function valueLiteral(expr)
{
    return expr.value;
}

expressions["BooleanLiteral"] = valueLiteral;
expressions["NumericLiteral"] = function(expr)
{
    if(expr.raw && expr.raw.indexOf(".") != -1 && Math.floor(expr.value) == expr.value)
        return expr.value + 0.000001;
    else
        return expr.value;
};
expressions["StringLiteral"] = valueLiteral;

expressions["Identifier"] = function(expr)
{
    var val = scope.get(expr.name);
    if(!val)
        throwError("use of undefined variable " + expr.name, expr.loc);
    return val;
};

expressions["CallExpression"] = function(expr)
{
    var base = compileExpression(expr.base);
    var args = [];

    for(var i = 0; i < expr.arguments.length; i++)
    {
        args[i] = compileExpression(expr.arguments[i]);
    }

    if(typeof base != "function")
        throwError(base.constructor.name + " is not a function", expr.loc);

    try
    {
        return base.apply(undefined, args);
    }
    catch (e)
    {
        var fnName = expr.base.name || base.name;

        if(options.debug)
        {
            console.log("- while calling " + fnName);
            throw e;
        }

        throwError(e.toString() + "\n- while calling " + fnName, expr.loc);
    }
};

expressions["UnaryExpression"] = function(expr)
{
    var left = compileExpression(expr.argument);

    if(expr.operator == "not")
    {
        return "/" + falseify(left, expr.loc);
    }
    else if(expr.operator == "-")
    {
        if(typeof left == "object")
        {
            var clone = left.isClone ? left : left.clone();
            clone.isClone = true;

            checkOperator(left, "multiplicate", "-", expr.loc);
            clone.multiplicate(-1);

            return clone;
        }
        else
        {
            return -1 * left;
        }
    }
    else if(expr.operator == "#")
    {
        if(left.hasOwnProperty("length"))
            return left.length;
        else
            throwError("Cannot get the length of a variable of type " + left.constructor.name, expr.loc);
    }
};

expressions["LogicalExpression"] = function(expr)
{
    var left = compileExpression(expr.left);
    var right = compileExpression(expr.right);
    var operator = expr.operator;

    var compileTimeOps = {
        "and": function(a, b) { return a && b; },
        "or": function(a, b) { return a || b; }
    };

    var isLeftCmd = typeof left == "string" && expr.left.type != "StringLiteral";
    var isRightCmd = typeof right == "string" && expr.right.type != "StringLiteral";

    if(isLeftCmd && !isRightCmd)
    {
        left = commandToBool(left);
    }
    else if(isRightCmd && !isLeftCmd)
    {
        right = commandToBool(right);
    }

    if(typeof left != "object" && typeof right != "object" && !(isLeftCmd || isRightCmd))
        return compileTimeOps[operator](left, right);

    var _left = typeof left == "object" ? left : right;
    var _right = typeof left == "object" ? right : left;

    if(typeMatch(left, right) && !(isLeftCmd || isRightCmd))
    {
        var val = new _left.constructor(_left, nextName(operator));
        val.isClone = true;

        if(operator == "and")
        {
            var isLeftTrue = trueify(_left, expr.loc);
            command(isLeftTrue);
            val.set(_right, true);
        }
        else if(operator == "or")
        {
            var isLeftFalse = falseify(_left, expr.loc);
            command(isLeftFalse);
            val.set(_right, true);
        }

        return val;
    }
    else
    {
        if(operator == "and")
        {
            var val = new types.Boolean(false, nextName("and"));
            val.isClone = true;
            var isLeftTrue = trueify(_left, expr.loc);
            var isRightTrue = trueify(_right, expr.loc);

            command(isLeftTrue);
            command(isRightTrue, true);
            val.set(true, true);

            return val;
        }
        else if(operator == "or")
        {
            var val = new types.Boolean(true, nextName("and"));
            val.isClone = true;
            var isLeftFalse = falseify(_left, expr.loc);
            var isRightFalse = falseify(_right, expr.loc);

            command(isLeftFalse);
            command(isRightFalse, true);
            val.set(false, true);

            return val;
        }
    }
};

expressions["BinaryExpression"] = function(expr)
{
    var left = compileExpression(expr.left);
    var right = compileExpression(expr.right);
    var operator = expr.operator;

    checkTypeMismatch(left, right, expr.loc);

    var noCommutative = ["/", "%", "<", ">", "<=", ">="];

    var compileTimeOps = {
        "+": function(a, b) { return a + b; },
        "-": function(a, b) { return a - b; },
        "*": function(a, b) { return a * b; },
        "/": function(a, b) { return a / b; },
        "%": function(a, b) { return a % b; },
        "..": function(a, b) { return a.toString() + b.toString(); },
        "^": function(a, b) { return Math.pow(a, b); },
        "==": function(a, b) { return a == b; },
        "!=": function(a, b) { return a != b; },
        ">": function(a, b) { return a > b; },
        "<": function(a, b) { return a < b; },
        ">=": function(a, b) { return a >= b; },
        "<=": function(a, b) { return a <= b; }
    };

    var runtimeOps = {
        "+": "add",
        "-": "remove",
        "*": "multiplicate",
        "/": "divide",
        "%": "mod",
        "..": function(a, b)
        {
            throwError("Operator '..' is not supported for runtime variables", expr.loc);
        },
        "^": function(a, b)
        {
            throwError("Unsupported operator '^' use the math function 'pow' instead", expr.loc);
        },
        "==": function(a, b)
        {
            checkOperator(a, "isExact", operator, expr.loc);
            return a.isExact(b);
        },
        "~=": function(a, b)
        {
            checkOperator(a, "isExact", operator, expr.loc);
            var label = nextName("not");
            base.addLabel(label);
            command(a.isExact(b));
            return "testforblock %" + label + ":diff% minecraft:chain_command_block -1 {SuccessCount:0}";
        },
        ">": function(a, b)
        {
            checkOperator(a, "isBetweenEx", operator, expr.loc);
            return a.isBetweenEx(b, undefined);
        },
        "<": function(a, b)
        {
            checkOperator(a, "isBetweenEx", operator, expr.loc);
            return a.isBetweenEx(undefined, b);
        },
        ">=": function(a, b)
        {
            checkOperator(a, "isBetween", operator, expr.loc);
            return a.isBetween(b, undefined);
        },
        "<=": function(a, b)
        {
            checkOperator(a, "isBetween", operator, expr.loc);
            return a.isBetween(undefined, b);
        }
    };

    if(typeof left != "object" && typeof right != "object")
    {
        return compileTimeOps[operator](left, right);
    }
    else if(typeof right == "object" && (typeof left == "object"  || noCommutative.indexOf(operator) != -1))
    {
        var op = runtimeOps[operator];

        if(typeof left != "object")
            left = createRuntimeVar(left);

        checkOperator(left, "clone", "clone", expr.loc);
        var clone = left.isClone ? left : left.clone();
        clone.isClone = true;

        if(typeof op == "string")
        {
            checkOperator(clone, op, operator, expr.loc);
            clone[op](right);
            return clone;
        }
        else
        {
            checkOperator(left, "remove", "-", expr.loc);
            clone.remove(right);
            return "/" + op(clone, 0);
        }
    }
    else
    {
        var _left = typeof left == "object" ? left : right;
        var _right = typeof right == "object" ? left : right;

        var op = runtimeOps[operator];
        if(typeof op == "string")
        {
            checkOperator(_left, "clone", "clone", expr.loc);
            var clone = _left.isClone ? _left : _left.clone();
            clone.isClone = true;

            checkOperator(clone, op, operator, expr.loc);
            clone[op](_right);
            return clone;
        }
        else
        {
            return "/" + op(_left, _right);
        }
    }
};

},{"./lib/Scope.js":2,"./lib/base.js":3,"./lib/naming.js":5,"./lib/optimize.js":6,"./lib/types.js":7}],2:[function(require,module,exports){
function Scope()
{
    this.stack = [{}];
}

Scope.prototype.increase = function(val)
{
    this.stack.push(val || {});
};

Scope.prototype.decrease = function()
{
    if(this.stack.length == 1)
        throw "cannot go below global in scope";

    return this.stack.splice(this.stack.length - 1, 1)[0];
};

Scope.prototype.current = function()
{
    return this.stack[this.stack.length - 1];
};

Scope.prototype.set = function(key, val)
{
    this.current()[key] = val;
};

Scope.prototype.get = function(key)
{
    for(var i = this.stack.length - 1; i >= 0; i--)
    {
        if(this.stack[i].hasOwnProperty(key))
        {
            return this.stack[i][key];
        }
    }
};

Scope.prototype.save = function()
{
    return this.stack.slice(0);
};

Scope.prototype.load = function(stack)
{
    this.stack = stack;
};

Scope.prototype.setGlobal = function(key, val)
{
    this.stack[0][key] = val;
};

module.exports = new Scope();

},{}],3:[function(require,module,exports){
var optimize = require("./optimize.js");
var scoreName = require("./types.js").Integer.scoreName;

var functions = {};

var currBlocks = [];
var currLabel;
var blockCache = {};
var createLabel = [];

exports.command = GLOBAL.command = function command(cmd, conditional)
{
    conditional = !!conditional;
    var data = {type: "command", command: cmd, conditional: conditional, label: createLabel.slice(0)};
    currBlocks.push(data);

    if(createLabel.length > 0)
        createLabel = [];
};

exports.unshiftCommand = function unshiftCommand(cmd, conditional)
{
    conditional = !!conditional;
    var data = {type: "command", command: cmd, conditional: conditional, label: createLabel.slice(0)};
    currBlocks.unshift(data);
};

exports.block = GLOBAL.block = function block(tagName, data)
{
    currBlocks.push({type: "block", tagName: tagName, data: data || 0});
};

exports.jump = function jump(label, conditional)
{
    command("setblock %" + label + ":jmp% command_block 0 replace {Command:\"setblock ~ ~ ~ air\",auto:1b}", conditional);
};

exports.rjump = function rjump(label, conditional)
{
    command("summon ArmorStand %3:jmp% {NoGravity:1,Tags:[\"stack\"],CustomName:\"{0}\"}".format(label));
    command("scoreboard players add @e[type=ArmorStand,tag=stack] {0} 1".format(scoreName));
    exports.jump(label, conditional);
    block(options.splitterBlock);
};

exports.ret = function ret()
{
    command("execute @e[type=ArmorStand,tag=stack,score_{0}=1] ".format(scoreName) +
        "~ ~ ~ setblock ~ ~ ~ command_block 0 replace {Command:\"setblock ~ ~ ~ air\",auto:1b}");
    command("kill @e[type=ArmorStand,tag=stack,score_{0}=1]".format(scoreName));
    command("scoreboard players remove @e[type=ArmorStand,tag=stack] {0} 1".format(scoreName));
    block(options.splitterBlock);
};

exports.addLabel = function addLabel(name)
{
    createLabel.push(name);
};

exports.addFunction = function(label, fn)
{
    if(functions[label] == fn)
        return;
    else if(functions[label])
        throw "cannot use label " + label + " twice";

    var _blocks = currBlocks;
    var _createLabel = createLabel;
    currBlocks = [];
    createLabel = [];

    exports.addLabel(label);
    fn();

    functions[label] = currBlocks;
    currBlocks = _blocks;
    createLabel = _createLabel;
};

exports.reset = function()
{
    functions = {};

    currBlocks = [];
    currLabel;
    blockCache = {};
    createLabel = [];

    x = options.x;
    y = options.y;
    z = options.z;
    maxLength = options.length;
    direction = 5;
    nextDirection;
    curr = 1;

    label = exports.jmpLabel = {};
    cmdBlocks = [];
    outputBlocks = [];
};

/*exports.newFunction = function(label)
{
    functions[currLabel] = currBlocks;
    currBlocks = [];

    exports.addLabel(label);
    currLabel = label;
}*/

var x = options.x;
var y = options.y;
var z = options.z;
var maxLength = options.length;
var direction = 5;
var nextDirection;
var curr = 1;
function move()
{
    if(direction == 5)
        x++;
    else if(direction == 4)
        x--;
    else if(direction == 3)
        z++;

    curr++;
    if(curr >= maxLength)
    {
        if(direction == 5)
        {
            direction = 3;
            nextDirection = 4;
        }
        else if(direction == 4)
        {
            direction = 3;
            nextDirection = 5;
        }
        else if(direction == 3)
        {
            direction = nextDirection;
            curr = 1;
        }
    }
}

var label = exports.jmpLabel = {};
var cmdBlocks = [];
var outputBlocks = [];
function format(cmd, index)
{
    var reg = /%[a-zA-Z0-9-\+_]+:[a-zA-Z]+%/;
    while(reg.test(cmd))
    {
        var result = reg.exec(cmd)[0];
        var split = result.slice(1, -1).split(":");
        var descriptor = split[0];
        var query = split[1];

        var block;
        if(!isNaN(parseInt(descriptor)))
            block = cmdBlocks[index + parseInt(descriptor)];
        else if(typeof label[descriptor] != "undefined")
            block = label[descriptor];
        else
            break; //throw "invalid formatting symbol " + result;

        var diffX = block.x - cmdBlocks[index].x;
        var diffY = block.y - cmdBlocks[index].y;
        var diffZ = block.z - cmdBlocks[index].z;
        block.diff = "~" + diffX + " ~" + diffY + " ~" + diffZ;
        block.diffR = "~" + (-1 * diffX) + " ~" + (-1 * diffY) + " ~" + (-1 * diffZ);
        block.jmp = "~" + diffX + " ~" + (diffY + 1) + " ~" + diffZ;

        cmd = cmd.replace(result, block[query].toString());
    }
    return cmd;
}

exports.output = function output(outputHandler)
{
    var _functions = [optimize.removeDoubleSplit(currBlocks)];
    for(var key in functions)
        _functions.push(optimize.removeDoubleSplit(functions[key]));

    for(var i0 = 0; i0 < _functions.length; i0++)
    {
        var blocks = _functions[i0];
        for(var i = 0; i < blocks.length; i++)
        {
            if(blocks[i].type == "command")
            {
                if(blocks[i + 1] && blocks[i + 1].conditional) //conditional commandblocks cannot be in corners
                {
                    var count = 0;
                    for(var ii = i + 1; blocks[ii] && blocks[ii].conditional; ii++)
                    {
                        count++;
                    }

                    if(curr + count >= maxLength)
                    {
                        while(curr != 1)
                        {
                            outputBlocks.push({x: x, y: y, z: z, tagName: "chain_command_block", data: direction});
                            move();
                        }
                    }
                }


                var blockData = blocks[i].conditional ? direction + 8 : direction;
                cmdBlocks.push({x: x, y: y, z: z, data: blockData, command: blocks[i].command});

                var _label = blocks[i].label;
                for(var ii = 0; ii < _label.length; ii++)
                {
                    label[_label[ii]] = {x: x, y: y, z: z};
                }
            }
            else if(blocks[i].type == "block")
            {
                outputBlocks.push({x: x, y: y, z: z, tagName: blocks[i].tagName, data: blocks[i].data});
            }
            move();
        }

        outputBlocks.push({x: x, y: y, z: z, tagName: options.splitterBlock, data: 0});
        move();
    }

    for(var i = 0; i < createLabel.length; i++)
        label[createLabel[i]] = {x: x, y: y, z: z};

    for(var i = 0; i < cmdBlocks.length; i++)
    {
        cmdBlocks[i].command = format(cmdBlocks[i].command, i, cmdBlocks);
    }

    outputHandler(outputBlocks, cmdBlocks);
};

},{"./optimize.js":6,"./types.js":7}],4:[function(require,module,exports){
(function (__dirname){
var path = require("path");
var fs = require("fs");
var vm = require("vm");

var types = require("./types.js");
var scope = require("./Scope.js");
var base = require("./base.js");
GLOBAL.scope = scope;

var parser = require("./../luaparse.js");
var compile = require("./../compiler.js");

var cache = [];
var stdlib = {};
exports.srcPath = "";

exports.import = function(name, isMain)
{
    luaImport(name);

    if(isMain)
    {
        var Integer = types.Integer;
        for(var i = 0; i < Integer.statics.length; i++)
            base.unshiftCommand(["scoreboard players set", "static" + Integer.statics[i], Integer.scoreName, Integer.statics[i]].join(" "));

        base.unshiftCommand("scoreboard objectives add " + Integer.scoreName + " dummy MoonCraft Variables");

        if(types.Table.used)
        {
            base.unshiftCommand("scoreboard objectives add " + types.Table.indexScoreName + " dummy MoonCraft Table");
            base.unshiftCommand("scoreboard objectives add " + types.Table.tmpScoreName + " dummy MoonCraft temp");
        }
    }
};

exports.reset = function()
{
    cache = [];
};

(function()
{
    var stdlibPath = path.join(__dirname, "../../stdlib/");
    var files = fs.readdirSync(stdlibPath); //had trouble with async version

    for(var i = 0; i < files.length; i++)
    {
        var ext = path.extname(files[i]);
        var name = path.basename(files[i], ext);

        if(ext == ".js" || ext == ".lua")
            stdlib[name] = path.join(stdlibPath, files[i]);
    }
})();

scope.set("command", require("./base.js").command);

scope.set("import", luaImport);
function luaImport(name)
{
    var file;
    if(stdlib.hasOwnProperty(name))
    {
        file = stdlib[name];
    }
    else
    {
        if(path.isAbsolute(name))
            file = name;
        else
            file = path.resolve(path.join(exports.srcPath, name));

        if(!fs.existsSync(file))
            throw "cannot import module " + name + ", file " + file + " does not exist";
    }

    if(cache.indexOf(file) != -1)
        return;
    cache.push(file);

    var ext = path.extname(file);

    if(ext == ".lua")
    {
        var oldStack = scope.save();
        scope.load([scope.stack[0]]);
        scope.increase();

        var _srcPath = exports.srcPath;
        exports.srcPath = path.dirname(file);
        var _file = compile.file;
        compile.file = file;

        try
        {
            var src = fs.readFileSync(file).toString();
            var ast = parser.parse(src, {locations: true});
        }
        catch(e)
        {
            console.log("in file " + file);
            throw e;
        }
        compile(ast, path.dirname(file), false);

        exports.srcPath = _srcPath;
        compile.file = _file;

        scope.load(oldStack);
    }
    else if(ext == ".js")
    {
        var obj = require(file);
        for(var key in obj)
        {
            scope.setGlobal(key, obj[key]);
        }
    }
    else
    {
        throw "cannot import module " + name + ", unknown file extension " + ext;
    }
}

scope.set("js_eval", function(code)
{
    var context = {};
    for(var i = 0; i < scope.stack.length; i++)
    {
        for(var key in scope.stack[i])
            context[key] = scope.stack[i][key];
    }

    context = vm.createContext(context);
    return vm.runInContext(code, context);
});

scope.set("boolean", function(val, name)
{
    return new types.Boolean(val || false, name);
});

scope.set("int", function(val, name)
{
    return new types.Integer(val || 0, name);
});

scope.set("float", function(val, name)
{
    return new types.Float(val || 0, name);
});

scope.set("string", function(val, name)
{
    return new types.String(val || "", name);
});

scope.set("score", function(selector, objective)
{
    return new types.Score(selector, objective);
});

scope.set("type", function(val)
{
    return val.constructor.name;
});

scope.set("table_getn", function(table)
{
    return table.length;
});

scope.set("table_maxn", function(table)
{
    return table.maxn;
});

scope.set("table_slice", function(table, start, end)
{
    table.slice(start, end);
});

scope.set("table_insert", function(table, index, value)
{
    table.insert(index, value);
});

scope.set("table_remove", function(table, index)
{
    table.remove(index);
});

scope.set("OBJECTIVE_NAME", types.Integer.scoreName);

}).call(this,"/../../MoonCraft/src/lib")
},{"./../compiler.js":1,"./../luaparse.js":8,"./Scope.js":2,"./base.js":3,"./types.js":7,"fs":"fs","path":26,"vm":28}],5:[function(require,module,exports){
var func = function(name)
{
    func.names[name] = func.names[name] + 1 || 0;
    return name + "_" + func.names[name];
};
func.names = {};

module.exports = func;

},{}],6:[function(require,module,exports){
var scope = require("./Scope.js");

exports.selfAssign = function(left, val) // a = a + b --> a += b
{
    var leftSupported = ["+", "-", "*", "/", "%"];
    var rightSupported = ["+", "-", "*"];

    var varName = left.name;
    if(val.type == "BinaryExpression")
    {
        var op = val.operator;

        if(val.left.type == "Identifier" && val.left.name == varName && leftSupported.indexOf(op) != -1)
            return {operator: op, argument: val.right};
        else if(val.right.type == "Identifier" && val.right.name == varName && rightSupported.indexOf(op) != -1)
            return {operator: op, argument: val.left};
    }
};

exports.removeDeadEnds = function(stmtList)
{
    var endExpressions = ["ReturnStatement", "BreakStatement"];

    for(var i = 0; i < stmtList.length; i++)
    {
        var type = stmtList[i].type;
        if(endExpressions.indexOf(stmtList[i].type) != -1)
            return stmtList.slice(0, i + 1);
    }
    return stmtList;
};

exports.garbageCollect = function()
{
    var currScope = scope.current();

    for(var key in currScope)
    {
        if(currScope[key].clean)
            currScope[key].clean();
    }
};

exports.removeDoubleSplit = function(blocks)
{
    var sBlock = options.splitterBlock;
    for(var i = 0; i < blocks.length; i++)
    {
        if(blocks[i].tagName == sBlock && (blocks[i + 1] || {}).tagName == sBlock)
        {
            blocks.splice(i, 1);
            i--;
        }
    }

    if(blocks[blocks.length - 1].tagName == sBlock)
        blocks.splice(blocks.length - 1, 1);

    return blocks;
};

},{"./Scope.js":2}],7:[function(require,module,exports){
exports.Integer = require("./../types/Integer.js");
exports.Boolean = require("./../types/Boolean.js");
exports.Float = require("./../types/Float.js");
exports.String = require("./../types/String.js");
exports.Score = require("./../types/Score.js");
exports.Table = require("./../types/Table.js");

},{"./../types/Boolean.js":11,"./../types/Float.js":12,"./../types/Integer.js":13,"./../types/Score.js":14,"./../types/String.js":15,"./../types/Table.js":16}],8:[function(require,module,exports){
(function (global){
/* global exports:true, module:true, require:true, define:true, global:true */

(function (root, name, factory) {
  /* jshint eqeqeq:false */
  'use strict';

  // Used to determine if values are of the language type `Object`
  var objectTypes = {
        'function': true
      , 'object': true
    }
    // Detect free variable `exports`
    , freeExports = objectTypes[typeof exports] && exports && !exports.nodeType && exports
    // Detect free variable `module`
    , freeModule = objectTypes[typeof module] && module && !module.nodeType && module
    // Detect free variable `global`, from Node.js or Browserified code, and
    // use it as `window`
    , freeGlobal = freeExports && freeModule && typeof global == 'object' && global
    // Detect the popular CommonJS extension `module.exports`
    , moduleExports = freeModule && freeModule.exports === freeExports && freeExports;

  if (freeGlobal && (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal || freeGlobal.self === freeGlobal)) {
    root = freeGlobal;
  }

  // Some AMD build optimizers, like r.js, check for specific condition
  // patterns like the following:
  if (typeof define == 'function' && typeof define.amd == 'object' && define.amd) {
    // defined as an anonymous module.
    define(['exports'], factory);
    // In case the source has been processed and wrapped in a define module use
    // the supplied `exports` object.
    if (freeExports && moduleExports) factory(freeModule.exports);
  }
  // check for `exports` after `define` in case a build optimizer adds an
  // `exports` object
  else if (freeExports && freeModule) {
    // in Node.js or RingoJS v0.8.0+
    if (moduleExports) factory(freeModule.exports);
    // in Narwhal or RingoJS v0.7.0-
    else factory(freeExports);
  }
  // in a browser or Rhino
  else {
    factory((root[name] = {}));
  }
}(this, 'luaparse', function (exports) {
  'use strict';

  exports.version = '0.2.0';

  var input, options, length;

  // Options can be set either globally on the parser object through
  // defaultOptions, or during the parse call.
  var defaultOptions = exports.defaultOptions = {
    // Explicitly tell the parser when the input ends.
      wait: false
    // Store comments as an array in the chunk object.
    , comments: true
    // Track identifier scopes by adding an isLocal attribute to each
    // identifier-node.
    , scope: false
    // Store location information on each syntax node as
    // `loc: { start: { line, column }, end: { line, column } }`.
    , locations: false
    // Store the start and end character locations on each syntax node as
    // `range: [start, end]`.
    , ranges: false
    // A callback which will be invoked when a syntax node has been completed.
    // The node which has been created will be passed as the only parameter.
    , onCreateNode: null
    // A callback which will be invoked when a new scope is created.
    , onCreateScope: null
    // A callback which will be invoked when the current scope is destroyed.
    , onDestroyScope: null
  };

  // The available tokens expressed as enum flags so they can be checked with
  // bitwise operations.

  var EOF = 1, StringLiteral = 2, Keyword = 4, Identifier = 8
    , NumericLiteral = 16, Punctuator = 32, BooleanLiteral = 64
    , NilLiteral = 128, VarargLiteral = 256;

  exports.tokenTypes = { EOF: EOF, StringLiteral: StringLiteral
    , Keyword: Keyword, Identifier: Identifier, NumericLiteral: NumericLiteral
    , Punctuator: Punctuator, BooleanLiteral: BooleanLiteral
    , NilLiteral: NilLiteral, VarargLiteral: VarargLiteral
  };

  // As this parser is a bit different from luas own, the error messages
  // will be different in some situations.

  var errors = exports.errors = {
      unexpected: 'unexpected %1 \'%2\' near \'%3\''
    , expected: '\'%1\' expected near \'%2\''
    , expectedToken: '%1 expected near \'%2\''
    , unfinishedString: 'unfinished string near \'%1\''
    , malformedNumber: 'malformed number near \'%1\''
    , invalidVar: 'invalid left-hand side of assignment near \'%1\''
  };

  // ### Abstract Syntax Tree
  //
  // The default AST structure is inspired by the Mozilla Parser API but can
  // easily be customized by overriding these functions.

  var ast = exports.ast = {
      labelStatement: function(label) {
      return {
          type: 'LabelStatement'
        , label: label
      };
    }

    , breakStatement: function() {
      return {
          type: 'BreakStatement'
      };
    }

    , gotoStatement: function(label) {
      return {
          type: 'GotoStatement'
        , label: label
      };
    }

    , returnStatement: function(args) {
      return {
          type: 'ReturnStatement'
        , 'arguments': args
      };
    }

    , ifStatement: function(clauses) {
      return {
          type: 'IfStatement'
        , clauses: clauses
      };
    }
    , ifClause: function(condition, body) {
      return {
          type: 'IfClause'
        , condition: condition
        , body: body
      };
    }
    , elseifClause: function(condition, body) {
      return {
          type: 'ElseifClause'
        , condition: condition
        , body: body
      };
    }
    , elseClause: function(body) {
      return {
          type: 'ElseClause'
        , body: body
      };
    }

    , whileStatement: function(condition, body) {
      return {
          type: 'WhileStatement'
        , condition: condition
        , body: body
      };
    }

    , doStatement: function(body) {
      return {
          type: 'DoStatement'
        , body: body
      };
    }

    , repeatStatement: function(condition, body) {
      return {
          type: 'RepeatStatement'
        , condition: condition
        , body: body
      };
    }

    , localStatement: function(variables, init) {
      return {
          type: 'LocalStatement'
        , variables: variables
        , init: init
      };
    }

    , typedIdentifier: function(identifier, type) {
        return {
            type : 'TypedIdentifier'
          , identifier: identifier
          , varType: type
        }
    }

    , assignmentStatement: function(variables, init) {
      return {
          type: 'AssignmentStatement'
        , variables: variables
        , init: init
      };
    }

    , callStatement: function(expression) {
      return {
          type: 'CallStatement'
        , expression: expression
      };
    }

    , functionStatement: function(identifier, parameters, retTypes, isLocal, body) {
      return {
          type: 'FunctionDeclaration'
        , identifier: identifier
        , isLocal: isLocal
        , parameters: parameters
        , returnTypes: retTypes
        , body: body
      };
    }

    , forNumericStatement: function(variable, start, end, step, body) {
      return {
          type: 'ForNumericStatement'
        , variable: variable
        , start: start
        , end: end
        , step: step
        , body: body
      };
    }

    , forGenericStatement: function(variables, iterators, body) {
      return {
          type: 'ForGenericStatement'
        , variables: variables
        , iterators: iterators
        , body: body
      };
    }

    , chunk: function(body) {
      return {
          type: 'Chunk'
        , body: body
      };
    }

    , identifier: function(name) {
      return {
          type: 'Identifier'
        , name: name
      };
    }

    , literal: function(type, value, raw) {
      type = (type === StringLiteral) ? 'StringLiteral'
        : (type === NumericLiteral) ? 'NumericLiteral'
        : (type === BooleanLiteral) ? 'BooleanLiteral'
        : (type === NilLiteral) ? 'NilLiteral'
        : 'VarargLiteral';

      return {
          type: type
        , value: value
        , raw: raw
      };
    }

    , tableKey: function(key, value) {
      return {
          type: 'TableKey'
        , key: key
        , value: value
      };
    }
    , tableKeyString: function(key, value) {
      return {
          type: 'TableKeyString'
        , key: key
        , value: value
      };
    }
    , tableValue: function(value) {
      return {
          type: 'TableValue'
        , value: value
      };
    }


    , tableConstructorExpression: function(fields) {
      return {
          type: 'TableConstructorExpression'
        , fields: fields
      };
    }
    , binaryExpression: function(operator, left, right) {
      var type = ('and' === operator || 'or' === operator) ?
        'LogicalExpression' :
        'BinaryExpression';

      return {
          type: type
        , operator: operator
        , left: left
        , right: right
      };
    }
    , unaryExpression: function(operator, argument) {
      return {
          type: 'UnaryExpression'
        , operator: operator
        , argument: argument
      };
    }
    , memberExpression: function(base, indexer, identifier) {
      return {
          type: 'MemberExpression'
        , indexer: indexer
        , identifier: identifier
        , base: base
      };
    }

    , indexExpression: function(base, index) {
      return {
          type: 'IndexExpression'
        , base: base
        , index: index
      };
    }

    , callExpression: function(base, args) {
      return {
          type: 'CallExpression'
        , base: base
        , 'arguments': args
      };
    }

    , tableCallExpression: function(base, args) {
      return {
          type: 'TableCallExpression'
        , base: base
        , 'arguments': args
      };
    }

    , stringCallExpression: function(base, argument) {
      return {
          type: 'StringCallExpression'
        , base: base
        , argument: argument
      };
    }

    , comment: function(value, raw) {
      return {
          type: 'Comment'
        , value: value
        , raw: raw
      };
    }
  };

  // Wrap up the node object.

  function finishNode(node) {
    // Pop a `Marker` off the location-array and attach its location data.
    if (trackLocations) {
      var location = locations.pop();
      location.complete();
      if (options.locations) node.loc = location.loc;
      if (options.ranges) node.range = location.range;
    }
    if (options.onCreateNode) options.onCreateNode(node);
    return node;
  }


  // Helpers
  // -------

  var slice = Array.prototype.slice
    , toString = Object.prototype.toString
    , indexOf = function indexOf(array, element) {
      for (var i = 0, length = array.length; i < length; i++) {
        if (array[i] === element) return i;
      }
      return -1;
    };

  // Iterate through an array of objects and return the index of an object
  // with a matching property.

  function indexOfObject(array, property, element) {
    for (var i = 0, length = array.length; i < length; i++) {
      if (array[i][property] === element) return i;
    }
    return -1;
  }

  // A sprintf implementation using %index (beginning at 1) to input
  // arguments in the format string.
  //
  // Example:
  //
  //     // Unexpected function in token
  //     sprintf('Unexpected %2 in %1.', 'token', 'function');

  function sprintf(format) {
    var args = slice.call(arguments, 1);
    format = format.replace(/%(\d)/g, function (match, index) {
      return '' + args[index - 1] || '';
    });
    return format;
  }

  // Returns a new object with the properties from all objectes passed as
  // arguments. Last argument takes precedence.
  //
  // Example:
  //
  //     this.options = extend(options, { output: false });

  function extend() {
    var args = slice.call(arguments)
      , dest = {}
      , src, prop;

    for (var i = 0, length = args.length; i < length; i++) {
      src = args[i];
      for (prop in src) if (src.hasOwnProperty(prop)) {
        dest[prop] = src[prop];
      }
    }
    return dest;
  }

  // ### Error functions

  // #### Raise an exception.
  //
  // Raise an exception by passing a token, a string format and its paramters.
  //
  // The passed tokens location will automatically be added to the error
  // message if it exists, if not it will default to the lexers current
  // position.
  //
  // Example:
  //
  //     // [1:0] expected [ near (
  //     raise(token, "expected %1 near %2", '[', token.value);

  function raise(token) {
    var message = sprintf.apply(null, slice.call(arguments, 1))
      , error, col;

    if ('undefined' !== typeof token.line) {
      col = token.range[0] - token.lineStart;
      error = new SyntaxError(sprintf('[%1:%2] %3', token.line, col, message));
      error.line = token.line;
      error.index = token.range[0];
      error.column = col;
    } else {
      col = index - lineStart + 1;
      error = new SyntaxError(sprintf('[%1:%2] %3', line, col, message));
      error.index = index;
      error.line = line;
      error.column = col;
    }
    throw error;
  }

  // #### Raise an unexpected token error.
  //
  // Example:
  //
  //     // expected <name> near '0'
  //     raiseUnexpectedToken('<name>', token);

  function raiseUnexpectedToken(type, token) {
    raise(token, errors.expectedToken, type, token.value);
  }

  // #### Raise a general unexpected error
  //
  // Usage should pass either a token object or a symbol string which was
  // expected. We can also specify a nearby token such as <eof>, this will
  // default to the currently active token.
  //
  // Example:
  //
  //     // Unexpected symbol 'end' near '<eof>'
  //     unexpected(token);
  //
  // If there's no token in the buffer it means we have reached <eof>.

  function unexpected(found, near) {
    if ('undefined' === typeof near) near = lookahead.value;
    if ('undefined' !== typeof found.type) {
      var type;
      switch (found.type) {
        case StringLiteral:   type = 'string';      break;
        case Keyword:         type = 'keyword';     break;
        case Identifier:      type = 'identifier';  break;
        case NumericLiteral:  type = 'number';      break;
        case Punctuator:      type = 'symbol';      break;
        case BooleanLiteral:  type = 'boolean';     break;
        case NilLiteral:
          return raise(found, errors.unexpected, 'symbol', 'nil', near);
      }
      return raise(found, errors.unexpected, type, found.value, near);
    }
    return raise(found, errors.unexpected, 'symbol', found, near);
  }

  // Lexer
  // -----
  //
  // The lexer, or the tokenizer reads the input string character by character
  // and derives a token left-right. To be as efficient as possible the lexer
  // prioritizes the common cases such as identifiers. It also works with
  // character codes instead of characters as string comparisons was the
  // biggest bottleneck of the parser.
  //
  // If `options.comments` is enabled, all comments encountered will be stored
  // in an array which later will be appended to the chunk object. If disabled,
  // they will simply be disregarded.
  //
  // When the lexer has derived a valid token, it will be returned as an object
  // containing its value and as well as its position in the input string (this
  // is always enabled to provide proper debug messages).
  //
  // `lex()` starts lexing and returns the following token in the stream.

  var index
    , token
    , previousToken
    , lookahead
    , comments
    , tokenStart
    , line
    , lineStart;

  exports.lex = lex;

  function lex() {
    skipWhiteSpace();

    // Skip comments beginning with --
    while (45 === input.charCodeAt(index) &&
           45 === input.charCodeAt(index + 1)) {
      scanComment();
      skipWhiteSpace();
    }
    if (index >= length) return {
        type : EOF
      , value: '<eof>'
      , line: line
      , lineStart: lineStart
      , range: [index, index]
    };

    var charCode = input.charCodeAt(index)
      , next = input.charCodeAt(index + 1);

    // Memorize the range index where the token begins.
    tokenStart = index;
    if (isIdentifierStart(charCode)) return scanIdentifierOrKeyword();

    switch (charCode) {
      case 39: case 34: // '"
        return scanStringLiteral();

      // 0-9
      case 48: case 49: case 50: case 51: case 52: case 53:
      case 54: case 55: case 56: case 57:
        return scanNumericLiteral();

      case 46: // .
        // If the dot is followed by a digit it's a float.
        if (isDecDigit(next)) return scanNumericLiteral();
        if (46 === next) {
          if (46 === input.charCodeAt(index + 2)) return scanVarargLiteral();
          return scanPunctuator('..');
        }
        return scanPunctuator('.');

      case 61: // =
        if (61 === next) return scanPunctuator('==');
        return scanPunctuator('=');

      case 62: // >
        if (61 === next) return scanPunctuator('>=');
        if (62 === next) return scanPunctuator('>>');
        return scanPunctuator('>');

      case 60: // <
        if (60 === next) return scanPunctuator('<<');
        if (61 === next) return scanPunctuator('<=');
        return scanPunctuator('<');

      case 126: // ~
        if (61 === next) return scanPunctuator('~=');
        return scanPunctuator('~');

      case 58: // :
        if (58 === next) return scanPunctuator('::');
        return scanPunctuator(':');

      case 91: // [
        // Check for a multiline string, they begin with [= or [[
        if (91 === next || 61 === next) return scanLongStringLiteral();
        return scanPunctuator('[');

      case 47: // /
        // Check for integer division op (//)
        if (47 === next) return scanPunctuator('//');
        return scanPunctuator('/');

      // * ^ % , { } ] ( ) ; & # - + |
      case 42: case 94: case 37: case 44: case 123: case 124: case 125:
      case 93: case 40: case 41: case 59: case 38: case 35: case 45: case 43:
        return scanPunctuator(input.charAt(index));
    }

    return unexpected(input.charAt(index));
  }

  // Whitespace has no semantic meaning in lua so simply skip ahead while
  // tracking the encounted newlines. Any kind of eol sequence is counted as a
  // single line.

  function consumeEOL() {
    var charCode = input.charCodeAt(index)
      , peekCharCode = input.charCodeAt(index + 1);

    if (isLineTerminator(charCode)) {
      // Count \n\r and \r\n as one newline.
      if (10 === charCode && 13 === peekCharCode) index++;
      if (13 === charCode && 10 === peekCharCode) index++;
      line++;
      lineStart = ++index;

      return true;
    }
    return false;
  }

  function skipWhiteSpace() {
    while (index < length) {
      var charCode = input.charCodeAt(index);
      if (isWhiteSpace(charCode)) {
        index++;
      } else if (!consumeEOL()) {
        break;
      }
    }
  }

  // Identifiers, keywords, booleans and nil all look the same syntax wise. We
  // simply go through them one by one and defaulting to an identifier if no
  // previous case matched.

  function scanIdentifierOrKeyword() {
    var value, type;

    // Slicing the input string is prefered before string concatenation in a
    // loop for performance reasons.
    while (isIdentifierPart(input.charCodeAt(++index)));
    value = input.slice(tokenStart, index);

    // Decide on the token type and possibly cast the value.
    if (isKeyword(value)) {
      type = Keyword;
    } else if ('true' === value || 'false' === value) {
      type = BooleanLiteral;
      value = ('true' === value);
    } else if ('nil' === value) {
      type = NilLiteral;
      value = null;
    } else {
      type = Identifier;
    }

    return {
        type: type
      , value: value
      , line: line
      , lineStart: lineStart
      , range: [tokenStart, index]
    };
  }

  // Once a punctuator reaches this function it should already have been
  // validated so we simply return it as a token.

  function scanPunctuator(value) {
    index += value.length;
    return {
        type: Punctuator
      , value: value
      , line: line
      , lineStart: lineStart
      , range: [tokenStart, index]
    };
  }

  // A vararg literal consists of three dots.

  function scanVarargLiteral() {
    index += 3;
    return {
        type: VarargLiteral
      , value: '...'
      , line: line
      , lineStart: lineStart
      , range: [tokenStart, index]
    };
  }

  // Find the string literal by matching the delimiter marks used.

  function scanStringLiteral() {
    var delimiter = input.charCodeAt(index++)
      , stringStart = index
      , string = ''
      , charCode;

    while (index < length) {
      charCode = input.charCodeAt(index++);
      if (delimiter === charCode) break;
      if (92 === charCode) { // \
        string += input.slice(stringStart, index - 1) + readEscapeSequence();
        stringStart = index;
      }
      // EOF or `\n` terminates a string literal. If we haven't found the
      // ending delimiter by now, raise an exception.
      else if (index >= length || isLineTerminator(charCode)) {
        string += input.slice(stringStart, index - 1);
        raise({}, errors.unfinishedString, string + String.fromCharCode(charCode));
      }
    }
    string += input.slice(stringStart, index - 1);

    return {
        type: StringLiteral
      , value: string
      , line: line
      , lineStart: lineStart
      , range: [tokenStart, index]
    };
  }

  // Expect a multiline string literal and return it as a regular string
  // literal, if it doesn't validate into a valid multiline string, throw an
  // exception.

  function scanLongStringLiteral() {
    var string = readLongString();
    // Fail if it's not a multiline literal.
    if (false === string) raise(token, errors.expected, '[', token.value);

    return {
        type: StringLiteral
      , value: string
      , line: line
      , lineStart: lineStart
      , range: [tokenStart, index]
    };
  }

  // Numeric literals will be returned as floating-point numbers instead of
  // strings. The raw value should be retrieved from slicing the input string
  // later on in the process.
  //
  // If a hexadecimal number is encountered, it will be converted.

  function scanNumericLiteral() {
    var character = input.charAt(index)
      , next = input.charAt(index + 1);

    var value = ('0' === character && 'xX'.indexOf(next || null) >= 0) ?
      readHexLiteral() : readDecLiteral();

    return {
        type: NumericLiteral
      , value: value
      , line: line
      , lineStart: lineStart
      , range: [tokenStart, index]
    };
  }

  // Lua hexadecimals have an optional fraction part and an optional binary
  // exoponent part. These are not included in JavaScript so we will compute
  // all three parts separately and then sum them up at the end of the function
  // with the following algorithm.
  //
  //     Digit := toDec(digit)
  //     Fraction := toDec(fraction) / 16 ^ fractionCount
  //     BinaryExp := 2 ^ binaryExp
  //     Number := ( Digit + Fraction ) * BinaryExp

  function readHexLiteral() {
    var fraction = 0 // defaults to 0 as it gets summed
      , binaryExponent = 1 // defaults to 1 as it gets multiplied
      , binarySign = 1 // positive
      , digit, fractionStart, exponentStart, digitStart;

    digitStart = index += 2; // Skip 0x part

    // A minimum of one hex digit is required.
    if (!isHexDigit(input.charCodeAt(index)))
      raise({}, errors.malformedNumber, input.slice(tokenStart, index));

    while (isHexDigit(input.charCodeAt(index))) index++;
    // Convert the hexadecimal digit to base 10.
    digit = parseInt(input.slice(digitStart, index), 16);

    // Fraction part i optional.
    if ('.' === input.charAt(index)) {
      fractionStart = ++index;

      while (isHexDigit(input.charCodeAt(index))) index++;
      fraction = input.slice(fractionStart, index);

      // Empty fraction parts should default to 0, others should be converted
      // 0.x form so we can use summation at the end.
      fraction = (fractionStart === index) ? 0
        : parseInt(fraction, 16) / Math.pow(16, index - fractionStart);
    }

    // Binary exponents are optional
    if ('pP'.indexOf(input.charAt(index) || null) >= 0) {
      index++;

      // Sign part is optional and defaults to 1 (positive).
      if ('+-'.indexOf(input.charAt(index) || null) >= 0)
        binarySign = ('+' === input.charAt(index++)) ? 1 : -1;

      exponentStart = index;

      // The binary exponent sign requires a decimal digit.
      if (!isDecDigit(input.charCodeAt(index)))
        raise({}, errors.malformedNumber, input.slice(tokenStart, index));

      while (isDecDigit(input.charCodeAt(index))) index++;
      binaryExponent = input.slice(exponentStart, index);

      // Calculate the binary exponent of the number.
      binaryExponent = Math.pow(2, binaryExponent * binarySign);
    }

    return (digit + fraction) * binaryExponent;
  }

  // Decimal numbers are exactly the same in Lua and in JavaScript, because of
  // this we check where the token ends and then parse it with native
  // functions.

  function readDecLiteral() {
    while (isDecDigit(input.charCodeAt(index))) index++;
    // Fraction part is optional
    if ('.' === input.charAt(index)) {
      index++;
      // Fraction part defaults to 0
      while (isDecDigit(input.charCodeAt(index))) index++;
    }
    // Exponent part is optional.
    if ('eE'.indexOf(input.charAt(index) || null) >= 0) {
      index++;
      // Sign part is optional.
      if ('+-'.indexOf(input.charAt(index) || null) >= 0) index++;
      // An exponent is required to contain at least one decimal digit.
      if (!isDecDigit(input.charCodeAt(index)))
        raise({}, errors.malformedNumber, input.slice(tokenStart, index));

      while (isDecDigit(input.charCodeAt(index))) index++;
    }

    return parseFloat(input.slice(tokenStart, index));
  }


  // Translate escape sequences to the actual characters.

  function readEscapeSequence() {
    var sequenceStart = index;
    switch (input.charAt(index)) {
      // Lua allow the following escape sequences.
      // We don't escape the bell sequence.
      case 'n': index++; return '\n';
      case 'r': index++; return '\r';
      case 't': index++; return '\t';
      case 'v': index++; return '\x0B';
      case 'b': index++; return '\b';
      case 'f': index++; return '\f';
      // Skips the following span of white-space.
      case 'z': index++; skipWhiteSpace(); return '';
      // Byte representation should for now be returned as is.
      case 'x':
        // \xXX, where XX is a sequence of exactly two hexadecimal digits
        if (isHexDigit(input.charCodeAt(index + 1)) &&
            isHexDigit(input.charCodeAt(index + 2))) {
          index += 3;
          // Return it as is, without translating the byte.
          return '\\' + input.slice(sequenceStart, index);
        }
        return '\\' + input.charAt(index++);
      default:
        // \ddd, where ddd is a sequence of up to three decimal digits.
        if (isDecDigit(input.charCodeAt(index))) {
          while (isDecDigit(input.charCodeAt(++index)));
          return '\\' + input.slice(sequenceStart, index);
        }
        // Simply return the \ as is, it's not escaping any sequence.
        return input.charAt(index++);
    }
  }

  // Comments begin with -- after which it will be decided if they are
  // multiline comments or not.
  //
  // The multiline functionality works the exact same way as with string
  // literals so we reuse the functionality.

  function scanComment() {
    tokenStart = index;
    index += 2; // --

    var character = input.charAt(index)
      , content = ''
      , isLong = false
      , commentStart = index
      , lineStartComment = lineStart
      , lineComment = line;

    if ('[' === character) {
      content = readLongString();
      // This wasn't a multiline comment after all.
      if (false === content) content = character;
      else isLong = true;
    }
    // Scan until next line as long as it's not a multiline comment.
    if (!isLong) {
      while (index < length) {
        if (isLineTerminator(input.charCodeAt(index))) break;
        index++;
      }
      if (options.comments) content = input.slice(commentStart, index);
    }

    if (options.comments) {
      var node = ast.comment(content, input.slice(tokenStart, index));

      // `Marker`s depend on tokens available in the parser and as comments are
      // intercepted in the lexer all location data is set manually.
      if (options.locations) {
        node.loc = {
            start: { line: lineComment, column: tokenStart - lineStartComment }
          , end: { line: line, column: index - lineStart }
        };
      }
      if (options.ranges) {
        node.range = [tokenStart, index];
      }
      if (options.onCreateNode) options.onCreateNode(node);
      comments.push(node);
    }
  }

  // Read a multiline string by calculating the depth of `=` characters and
  // then appending until an equal depth is found.

  function readLongString() {
    var level = 0
      , content = ''
      , terminator = false
      , character, stringStart;

    index++; // [

    // Calculate the depth of the comment.
    while ('=' === input.charAt(index + level)) level++;
    // Exit, this is not a long string afterall.
    if ('[' !== input.charAt(index + level)) return false;

    index += level + 1;

    // If the first character is a newline, ignore it and begin on next line.
    if (isLineTerminator(input.charCodeAt(index))) consumeEOL();

    stringStart = index;
    while (index < length) {
      // To keep track of line numbers run the `consumeEOL()` which increments
      // its counter.
      if (isLineTerminator(input.charCodeAt(index))) consumeEOL();

      character = input.charAt(index++);

      // Once the delimiter is found, iterate through the depth count and see
      // if it matches.
      if (']' === character) {
        terminator = true;
        for (var i = 0; i < level; i++) {
          if ('=' !== input.charAt(index + i)) terminator = false;
        }
        if (']' !== input.charAt(index + level)) terminator = false;
      }

      // We reached the end of the multiline string. Get out now.
      if (terminator) break;
    }
    content += input.slice(stringStart, index - 1);
    index += level + 1;

    return content;
  }

  // ## Lex functions and helpers.

  // Read the next token.
  //
  // This is actually done by setting the current token to the lookahead and
  // reading in the new lookahead token.

  function next() {
    previousToken = token;
    token = lookahead;
    lookahead = lex();
  }

  // Consume a token if its value matches. Once consumed or not, return the
  // success of the operation.

  function consume(value) {
    if (value === token.value) {
      next();
      return true;
    }
    return false;
  }

  // Expect the next token value to match. If not, throw an exception.

  function expect(value) {
    if (value === token.value) next();
    else raise(token, errors.expected, value, token.value);
  }

  // ### Validation functions

  function isWhiteSpace(charCode) {
    return 9 === charCode || 32 === charCode || 0xB === charCode || 0xC === charCode;
  }

  function isLineTerminator(charCode) {
    return 10 === charCode || 13 === charCode;
  }

  function isDecDigit(charCode) {
    return charCode >= 48 && charCode <= 57;
  }

  function isHexDigit(charCode) {
    return (charCode >= 48 && charCode <= 57) || (charCode >= 97 && charCode <= 102) || (charCode >= 65 && charCode <= 70);
  }

  // From [Lua 5.2](http://www.lua.org/manual/5.2/manual.html#8.1) onwards
  // identifiers cannot use locale-dependet letters.

  function isIdentifierStart(charCode) {
    return (charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122) || 95 === charCode;
  }

  function isIdentifierPart(charCode) {
    return (charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122) || 95 === charCode || (charCode >= 48 && charCode <= 57);
  }

  // [3.1 Lexical Conventions](http://www.lua.org/manual/5.2/manual.html#3.1)
  //
  // `true`, `false` and `nil` will not be considered keywords, but literals.

  function isKeyword(id) {
    switch (id.length) {
      case 2:
        return 'do' === id || 'if' === id || 'in' === id || 'or' === id;
      case 3:
        return 'and' === id || 'end' === id || 'for' === id || 'not' === id;
      case 4:
        return 'else' === id || 'goto' === id || 'then' === id;
      case 5:
        return 'break' === id || 'local' === id || 'until' === id || 'while' === id;
      case 6:
        return 'elseif' === id || 'repeat' === id || 'return' === id;
      case 8:
        return 'function' === id;
    }
    return false;
  }

  function isUnary(token) {
    if (Punctuator === token.type) return '#-~'.indexOf(token.value) >= 0;
    if (Keyword === token.type) return 'not' === token.value;
    return false;
  }

  // @TODO this needs to be rethought.
  function isCallExpression(expression) {
    switch (expression.type) {
      case 'CallExpression':
      case 'TableCallExpression':
      case 'StringCallExpression':
        return true;
    }
    return false;
  }

  // Check if the token syntactically closes a block.

  function isBlockFollow(token) {
    if (EOF === token.type) return true;
    if (Keyword !== token.type) return false;
    switch (token.value) {
      case 'else': case 'elseif':
      case 'end': case 'until':
        return true;
      default:
        return false;
    }
  }

  // Scope
  // -----

  // Store each block scope as a an array of identifier names. Each scope is
  // stored in an FILO-array.
  var scopes
    // The current scope index
    , scopeDepth
    // A list of all global identifier nodes.
    , globals;

  // Create a new scope inheriting all declarations from the previous scope.
  function createScope() {
    var scope = Array.apply(null, scopes[scopeDepth++]);
    scopes.push(scope);
    if (options.onCreateScope) options.onCreateScope();
  }

  // Exit and remove the current scope.
  function destroyScope() {
    var scope = scopes.pop();
    scopeDepth--;
    if (options.onDestroyScope) options.onDestroyScope();
  }

  // Add identifier name to the current scope if it doesnt already exist.
  function scopeIdentifierName(name) {
    if (-1 !== indexOf(scopes[scopeDepth], name)) return;
    scopes[scopeDepth].push(name);
  }

  // Add identifier to the current scope
  function scopeIdentifier(node) {
    scopeIdentifierName(node.name);
    attachScope(node, true);
  }

  // Attach scope information to node. If the node is global, store it in the
  // globals array so we can return the information to the user.
  function attachScope(node, isLocal) {
    if (!isLocal && -1 === indexOfObject(globals, 'name', node.name))
      globals.push(node);

    node.isLocal = isLocal;
  }

  // Is the identifier name available in this scope.
  function scopeHasName(name) {
    return (-1 !== indexOf(scopes[scopeDepth], name));
  }

  // Location tracking
  // -----------------
  //
  // Locations are stored in FILO-array as a `Marker` object consisting of both
  // `loc` and `range` data. Once a `Marker` is popped off the list an end
  // location is added and the data is attached to a syntax node.

  var locations = []
    , trackLocations;

  function createLocationMarker() {
    return new Marker(token);
  }

  function Marker(token) {
    if (options.locations) {
      this.loc = {
          start: {
            line: token.line
          , column: token.range[0] - token.lineStart
        }
        , end: {
            line: 0
          , column: 0
        }
      };
    }
    if (options.ranges) this.range = [token.range[0], 0];
  }

  // Complete the location data stored in the `Marker` by adding the location
  // of the *previous token* as an end location.
  Marker.prototype.complete = function() {
    if (options.locations) {
      this.loc.end.line = previousToken.line;
      this.loc.end.column = previousToken.range[1] - previousToken.lineStart;
    }
    if (options.ranges) {
      this.range[1] = previousToken.range[1];
    }
  };

  // Create a new `Marker` and add it to the FILO-array.
  function markLocation() {
    if (trackLocations) locations.push(createLocationMarker());
  }

  // Push an arbitrary `Marker` object onto the FILO-array.
  function pushLocation(marker) {
    if (trackLocations) locations.push(marker);
  }

  // Parse functions
  // ---------------

  // Chunk is the main program object. Syntactically it's the same as a block.
  //
  //     chunk ::= block

  function parseChunk() {
    next();
    markLocation();
    if (options.scope) createScope();
    var body = parseBlock();
    if (options.scope) destroyScope();
    if (EOF !== token.type) unexpected(token);
    // If the body is empty no previousToken exists when finishNode runs.
    if (trackLocations && !body.length) previousToken = token;
    return finishNode(ast.chunk(body));
  }

  // A block contains a list of statements with an optional return statement
  // as its last statement.
  //
  //     block ::= {stat} [retstat]

  function parseBlock(terminator) {
    var block = []
      , statement;

    while (!isBlockFollow(token)) {
      // Return has to be the last statement in a block.
      if ('return' === token.value) {
        block.push(parseStatement());
        break;
      }
      statement = parseStatement();
      // Statements are only added if they are returned, this allows us to
      // ignore some statements, such as EmptyStatement.
      if (statement) block.push(statement);
    }

    // Doesn't really need an ast node
    return block;
  }

  // There are two types of statements, simple and compound.
  //
  //     statement ::= break | goto | do | while | repeat | return
  //          | if | for | function | local | label | assignment
  //          | functioncall | ';'

  function parseStatement() {
    markLocation();
    if (Keyword === token.type) {
      switch (token.value) {
        case 'local':    next(); return parseLocalStatement();
        case 'if':       next(); return parseIfStatement();
        case 'return':   next(); return parseReturnStatement();
        case 'function': next();
          var name = parseFunctionName();
          return parseFunctionDeclaration(name);
        case 'while':    next(); return parseWhileStatement();
        case 'for':      next(); return parseForStatement();
        case 'repeat':   next(); return parseRepeatStatement();
        case 'break':    next(); return parseBreakStatement();
        case 'do':       next(); return parseDoStatement();
        case 'goto':     next(); return parseGotoStatement();
      }
    }

    if (Punctuator === token.type) {
      if (consume('::')) return parseLabelStatement();
    }
    // Assignments memorizes the location and pushes it manually for wrapper
    // nodes. Additionally empty `;` statements should not mark a location.
    if (trackLocations) locations.pop();

    // When a `;` is encounted, simply eat it without storing it.
    if (consume(';')) return;

    return parseAssignmentOrCallStatement();
  }

  // ## Statements

  //     label ::= '::' Name '::'

  function parseLabelStatement() {
    var name = token.value
      , label = parseIdentifier();

    if (options.scope) {
      scopeIdentifierName('::' + name + '::');
      attachScope(label, true);
    }

    expect('::');
    return finishNode(ast.labelStatement(label));
  }

  //     break ::= 'break'

  function parseBreakStatement() {
    return finishNode(ast.breakStatement());
  }

  //     goto ::= 'goto' Name

  function parseGotoStatement() {
    var name = token.value
      , label = parseIdentifier();

    return finishNode(ast.gotoStatement(label));
  }

  //     do ::= 'do' block 'end'

  function parseDoStatement() {
    if (options.scope) createScope();
    var body = parseBlock();
    if (options.scope) destroyScope();
    expect('end');
    return finishNode(ast.doStatement(body));
  }

  //     while ::= 'while' exp 'do' block 'end'

  function parseWhileStatement() {
    var condition = parseExpectedExpression();
    expect('do');
    if (options.scope) createScope();
    var body = parseBlock();
    if (options.scope) destroyScope();
    expect('end');
    return finishNode(ast.whileStatement(condition, body));
  }

  //     repeat ::= 'repeat' block 'until' exp

  function parseRepeatStatement() {
    if (options.scope) createScope();
    var body = parseBlock();
    expect('until');
    var condition = parseExpectedExpression();
    if (options.scope) destroyScope();
    return finishNode(ast.repeatStatement(condition, body));
  }

  //     retstat ::= 'return' [exp {',' exp}] [';']

  function parseReturnStatement() {
    var expressions = [];

    if ('end' !== token.value) {
      var expression = parseExpression();
      if (null != expression) expressions.push(expression);
      while (consume(',')) {
        expression = parseExpectedExpression();
        expressions.push(expression);
      }
      consume(';'); // grammar tells us ; is optional here.
    }
    return finishNode(ast.returnStatement(expressions));
  }

  //     if ::= 'if' exp 'then' block {elif} ['else' block] 'end'
  //     elif ::= 'elseif' exp 'then' block

  function parseIfStatement() {
    var clauses = []
      , condition
      , body
      , marker;

    // IfClauses begin at the same location as the parent IfStatement.
    // It ends at the start of `end`, `else`, or `elseif`.
    if (trackLocations) {
      marker = locations[locations.length - 1];
      locations.push(marker);
    }
    condition = parseExpectedExpression();
    expect('then');
    if (options.scope) createScope();
    body = parseBlock();
    if (options.scope) destroyScope();
    clauses.push(finishNode(ast.ifClause(condition, body)));

    if (trackLocations) marker = createLocationMarker();
    while (consume('elseif')) {
      pushLocation(marker);
      condition = parseExpectedExpression();
      expect('then');
      if (options.scope) createScope();
      body = parseBlock();
      if (options.scope) destroyScope();
      clauses.push(finishNode(ast.elseifClause(condition, body)));
      if (trackLocations) marker = createLocationMarker();
    }

    if (consume('else')) {
      // Include the `else` in the location of ElseClause.
      if (trackLocations) {
        marker = new Marker(previousToken);
        locations.push(marker);
      }
      if (options.scope) createScope();
      body = parseBlock();
      if (options.scope) destroyScope();
      clauses.push(finishNode(ast.elseClause(body)));
    }

    expect('end');
    return finishNode(ast.ifStatement(clauses));
  }

  // There are two types of for statements, generic and numeric.
  //
  //     for ::= Name '=' exp ',' exp [',' exp] 'do' block 'end'
  //     for ::= namelist 'in' explist 'do' block 'end'
  //     namelist ::= Name {',' Name}
  //     explist ::= exp {',' exp}

  function parseForStatement() {
    var variable = parseIdentifier()
      , body;

    // The start-identifier is local.

    if (options.scope) {
      createScope();
      scopeIdentifier(variable);
    }

    // If the first expression is followed by a `=` punctuator, this is a
    // Numeric For Statement.
    if (consume('=')) {
      // Start expression
      var start = parseExpectedExpression();
      expect(',');
      // End expression
      var end = parseExpectedExpression();
      // Optional step expression
      var step = consume(',') ? parseExpectedExpression() : null;

      expect('do');
      body = parseBlock();
      expect('end');
      if (options.scope) destroyScope();

      return finishNode(ast.forNumericStatement(variable, start, end, step, body));
    }
    // If not, it's a Generic For Statement
    else {
      // The namelist can contain one or more identifiers.
      var variables = [variable];
      while (consume(',')) {
        variable = parseIdentifier();
        // Each variable in the namelist is locally scoped.
        if (options.scope) scopeIdentifier(variable);
        variables.push(variable);
      }
      expect('in');
      var iterators = [];

      // One or more expressions in the explist.
      do {
        var expression = parseExpectedExpression();
        iterators.push(expression);
      } while (consume(','));

      expect('do');
      body = parseBlock();
      expect('end');
      if (options.scope) destroyScope();

      return finishNode(ast.forGenericStatement(variables, iterators, body));
    }
  }

  // Local statements can either be variable assignments or function
  // definitions. If a function definition is found, it will be delegated to
  // `parseFunctionDeclaration()` with the isLocal flag.
  //
  // This AST structure might change into a local assignment with a function
  // child.
  //
  //     local ::= 'local' 'function' Name funcdecl
  //        | 'local' Name {',' Name} ['=' exp {',' exp}]

  function parseLocalStatement() {
    var name;

    if (Identifier === token.type) {
      var variables = []
        , init = [];

      do {
        name = parseIdentifier();

        if(consume(':')) {
            var type = parseIdentifier();
            variables.push(ast.typedIdentifier(name, type));
        }
        else {
            variables.push(name);
        }
      } while (consume(','));

      if (consume('=')) {
        do {
          var expression = parseExpectedExpression();
          init.push(expression);
        } while (consume(','));
      }

      // Declarations doesn't exist before the statement has been evaluated.
      // Therefore assignments can't use their declarator. And the identifiers
      // shouldn't be added to the scope until the statement is complete.
      if (options.scope) {
        for (var i = 0, l = variables.length; i < l; i++) {
          scopeIdentifier(variables[i]);
        }
      }

      return finishNode(ast.localStatement(variables, init));
    }
    if (consume('function')) {
      name = parseIdentifier();

      if (options.scope) {
        scopeIdentifier(name);
        createScope();
      }

      // MemberExpressions are not allowed in local function statements.
      return parseFunctionDeclaration(name, true);
    } else {
      raiseUnexpectedToken('<name>', token);
    }
  }

  function validateVar(node) {
    // @TODO we need something not dependent on the exact AST used. see also isCallExpression()
    if (node.inParens || (['Identifier', 'MemberExpression', 'IndexExpression'].indexOf(node.type) === -1)) {
      raise(token, errors.invalidVar, token.value);
    }
  }

  //     assignment ::= varlist '=' explist
  //     var ::= Name | prefixexp '[' exp ']' | prefixexp '.' Name
  //     varlist ::= var {',' var}
  //     explist ::= exp {',' exp}
  //
  //     call ::= callexp
  //     callexp ::= prefixexp args | prefixexp ':' Name args

  function parseAssignmentOrCallStatement() {
    // Keep a reference to the previous token for better error messages in case
    // of invalid statement
    var previous = token
      , expression, marker;

    if (trackLocations) marker = createLocationMarker();
    expression = parsePrefixExpression();

    if (null == expression) return unexpected(token);
    if (',='.indexOf(token.value) >= 0) {
      var variables = [expression]
        , init = []
        , exp;

      validateVar(expression);
      while (consume(',')) {
        exp = parsePrefixExpression();
        if (null == exp) raiseUnexpectedToken('<expression>', token);
        validateVar(exp);
        variables.push(exp);
      }
      expect('=');
      do {
        exp = parseExpectedExpression();
        init.push(exp);
      } while (consume(','));

      pushLocation(marker);
      return finishNode(ast.assignmentStatement(variables, init));
    }
    if (isCallExpression(expression)) {
      pushLocation(marker);
      return finishNode(ast.callStatement(expression));
    }
    // The prefix expression was neither part of an assignment or a
    // callstatement, however as it was valid it's been consumed, so raise
    // the exception on the previous token to provide a helpful message.
    return unexpected(previous);
  }



  // ### Non-statements

  //     Identifier ::= Name

  function parseIdentifier() {
    markLocation();
    var identifier = token.value;
    if (Identifier !== token.type) raiseUnexpectedToken('<name>', token);
    next();
    return finishNode(ast.identifier(identifier));
  }

  // Parse the functions parameters and body block. The name should already
  // have been parsed and passed to this declaration function. By separating
  // this we allow for anonymous functions in expressions.
  //
  // For local functions there's a boolean parameter which needs to be set
  // when parsing the declaration.
  //
  //     funcdecl ::= '(' [parlist] ')' block 'end'
  //     parlist ::= Name {',' Name} | [',' '...'] | '...'

  function parseFunctionDeclaration(name, isLocal) {
    var parameters = [];
    expect('(');

    // The declaration has arguments
    if (!consume(')')) {
      // Arguments are a comma separated list of identifiers, optionally ending
      // with a vararg.
      while (true) {
        if (Identifier === token.type) {
          var parameter = parseIdentifier();
          // Function parameters are local.
          if (options.scope) scopeIdentifier(parameter);

          if(consume(':')) {
              var type = parseIdentifier();
              parameters.push(ast.typedIdentifier(parameter, type));
          }
          else {
              parameters.push(parameter);
          }

          if (consume(',')) continue;
          else if (consume(')')) break;
        }
        // No arguments are allowed after a vararg.
        else if (VarargLiteral === token.type) {
          parameters.push(parsePrimaryExpression());
          expect(')');
          break;
        } else {
          raiseUnexpectedToken('<name> or \'...\'', token);
        }
      }
    }

    var retTypes = [];
    if (consume(':')) {
        while(true) {
            retTypes.push(parseIdentifier());
            if(consume(',')) continue;
            else break;
        }
    }

    var body = parseBlock();
    expect('end');
    if (options.scope) destroyScope();

    isLocal = isLocal || false;
    return finishNode(ast.functionStatement(name, parameters, retTypes, isLocal, body));
  }

  // Parse the function name as identifiers and member expressions.
  //
  //     Name {'.' Name} [':' Name]

  function parseFunctionName() {
    var base, name, marker;

    if (trackLocations) marker = createLocationMarker();
    base = parseIdentifier();

    if (options.scope) {
      attachScope(base, scopeHasName(base.name));
      createScope();
    }

    while (consume('.')) {
      pushLocation(marker);
      name = parseIdentifier();
      base = finishNode(ast.memberExpression(base, '.', name));
    }

    if (consume(':')) {
      pushLocation(marker);
      name = parseIdentifier();
      base = finishNode(ast.memberExpression(base, ':', name));
      if (options.scope) scopeIdentifierName('self');
    }

    return base;
  }

  //     tableconstructor ::= '{' [fieldlist] '}'
  //     fieldlist ::= field {fieldsep field} fieldsep
  //     field ::= '[' exp ']' '=' exp | Name = 'exp' | exp
  //
  //     fieldsep ::= ',' | ';'

  function parseTableConstructor() {
    var fields = []
      , key, value;

    while (true) {
      markLocation();
      if (Punctuator === token.type && consume('[')) {
        key = parseExpectedExpression();
        expect(']');
        expect('=');
        value = parseExpectedExpression();
        fields.push(finishNode(ast.tableKey(key, value)));
      } else if (Identifier === token.type) {
        if ('=' === lookahead.value) {
          key = parseIdentifier();
          next();
          value = parseExpectedExpression();
          fields.push(finishNode(ast.tableKeyString(key, value)));
        } else {
          value = parseExpectedExpression();
          fields.push(finishNode(ast.tableValue(value)));
        }
      } else {
        if (null == (value = parseExpression())) {
          locations.pop();
          break;
        }
        fields.push(finishNode(ast.tableValue(value)));
      }
      if (',;'.indexOf(token.value) >= 0) {
        next();
        continue;
      }
      break;
    }
    expect('}');
    return finishNode(ast.tableConstructorExpression(fields));
  }

  // Expression parser
  // -----------------
  //
  // Expressions are evaluated and always return a value. If nothing is
  // matched null will be returned.
  //
  //     exp ::= (unop exp | primary | prefixexp ) { binop exp }
  //
  //     primary ::= nil | false | true | Number | String | '...'
  //          | functiondef | tableconstructor
  //
  //     prefixexp ::= (Name | '(' exp ')' ) { '[' exp ']'
  //          | '.' Name | ':' Name args | args }
  //

  function parseExpression() {
    var expression = parseSubExpression(0);
    return expression;
  }

  // Parse an expression expecting it to be valid.

  function parseExpectedExpression() {
    var expression = parseExpression();
    if (null == expression) raiseUnexpectedToken('<expression>', token);
    else return expression;
  }


  // Return the precedence priority of the operator.
  //
  // As unary `-` can't be distinguished from binary `-`, unary precedence
  // isn't described in this table but in `parseSubExpression()` itself.
  //
  // As this function gets hit on every expression it's been optimized due to
  // the expensive CompareICStub which took ~8% of the parse time.

  function binaryPrecedence(operator) {
    var charCode = operator.charCodeAt(0)
      , length = operator.length;

    if (1 === length) {
      switch (charCode) {
        case 94: return 12; // ^
        case 42: case 47: case 37: return 10; // * / %
        case 43: case 45: return 9; // + -
        case 38: return 6; // &
        case 126: return 5; // ~
        case 124: return 4; // |
        case 60: case 62: return 3; // < >
      }
    } else if (2 === length) {
      switch (charCode) {
        case 47: return 10; // //
        case 46: return 8; // ..
        case 60: case 62:
            if('<<' === operator || '>>' === operator) return 7; // << >>
            return 3; // <= >=
        case 61: case 126: return 3; // == ~=
        case 111: return 1; // or
      }
    } else if (97 === charCode && 'and' === operator) return 2;
    return 0;
  }

  // Implement an operator-precedence parser to handle binary operator
  // precedence.
  //
  // We use this algorithm because it's compact, it's fast and Lua core uses
  // the same so we can be sure our expressions are parsed in the same manner
  // without excessive amounts of tests.
  //
  //     exp ::= (unop exp | primary | prefixexp ) { binop exp }

  function parseSubExpression(minPrecedence) {
    var operator = token.value
    // The left-hand side in binary operations.
      , expression, marker;

    if (trackLocations) marker = createLocationMarker();

    // UnaryExpression
    if (isUnary(token)) {
      markLocation();
      next();
      var argument = parseSubExpression(10);
      if (argument == null) raiseUnexpectedToken('<expression>', token);
      expression = finishNode(ast.unaryExpression(operator, argument));
    }
    if (null == expression) {
      // PrimaryExpression
      expression = parsePrimaryExpression();

      // PrefixExpression
      if (null == expression) {
        expression = parsePrefixExpression();
      }
    }
    // This is not a valid left hand expression.
    if (null == expression) return null;

    var precedence;
    while (true) {
      operator = token.value;

      precedence = (Punctuator === token.type || Keyword === token.type) ?
        binaryPrecedence(operator) : 0;

      if (precedence === 0 || precedence <= minPrecedence) break;
      // Right-hand precedence operators
      if ('^' === operator || '..' === operator) precedence--;
      next();
      var right = parseSubExpression(precedence);
      if (null == right) raiseUnexpectedToken('<expression>', token);
      // Push in the marker created before the loop to wrap its entirety.
      if (trackLocations) locations.push(marker);
      expression = finishNode(ast.binaryExpression(operator, expression, right));

    }
    return expression;
  }

  //     prefixexp ::= prefix {suffix}
  //     prefix ::= Name | '(' exp ')'
  //     suffix ::= '[' exp ']' | '.' Name | ':' Name args | args
  //
  //     args ::= '(' [explist] ')' | tableconstructor | String

  function parsePrefixExpression() {
    var base, name, marker;

    if (trackLocations) marker = createLocationMarker();

    // The prefix
    if (Identifier === token.type) {
      name = token.value;
      base = parseIdentifier();
      // Set the parent scope.
      if (options.scope) attachScope(base, scopeHasName(name));
    } else if (consume('(')) {
      base = parseExpectedExpression();
      expect(')');
      base.inParens = true; // XXX: quick and dirty. needed for validateVar
    } else {
      return null;
    }

    // The suffix
    var expression, identifier;
    while (true) {
      if (Punctuator === token.type) {
        switch (token.value) {
          case '[':
            pushLocation(marker);
            next();
            expression = parseExpectedExpression();
            base = finishNode(ast.indexExpression(base, expression));
            expect(']');
            break;
          case '.':
            pushLocation(marker);
            next();
            identifier = parseIdentifier();
            base = finishNode(ast.memberExpression(base, '.', identifier));
            break;
          case ':':
            pushLocation(marker);
            next();
            identifier = parseIdentifier();
            base = finishNode(ast.memberExpression(base, ':', identifier));
            // Once a : is found, this has to be a CallExpression, otherwise
            // throw an error.
            pushLocation(marker);
            base = parseCallExpression(base);
            break;
          case '(': case '{': // args
            pushLocation(marker);
            base = parseCallExpression(base);
            break;
          default:
            return base;
        }
      } else if (StringLiteral === token.type) {
        pushLocation(marker);
        base = parseCallExpression(base);
      } else {
        break;
      }
    }

    return base;
  }

  //     args ::= '(' [explist] ')' | tableconstructor | String

  function parseCallExpression(base) {
    if (Punctuator === token.type) {
      switch (token.value) {
        case '(':
          next();

          // List of expressions
          var expressions = [];
          var expression = parseExpression();
          if (null != expression) expressions.push(expression);
          while (consume(',')) {
            expression = parseExpectedExpression();
            expressions.push(expression);
          }

          expect(')');
          return finishNode(ast.callExpression(base, expressions));

        case '{':
          markLocation();
          next();
          var table = parseTableConstructor();
          return finishNode(ast.tableCallExpression(base, table));
      }
    } else if (StringLiteral === token.type) {
      return finishNode(ast.stringCallExpression(base, parsePrimaryExpression()));
    }

    raiseUnexpectedToken('function arguments', token);
  }

  //     primary ::= String | Numeric | nil | true | false
  //          | functiondef | tableconstructor | '...'

  function parsePrimaryExpression() {
    var literals = StringLiteral | NumericLiteral | BooleanLiteral | NilLiteral | VarargLiteral
      , value = token.value
      , type = token.type
      , marker;

    if (trackLocations) marker = createLocationMarker();

    if (type & literals) {
      pushLocation(marker);
      var raw = input.slice(token.range[0], token.range[1]);
      next();
      return finishNode(ast.literal(type, value, raw));
    } else if (Keyword === type && 'function' === value) {
      pushLocation(marker);
      next();
      if (options.scope) createScope();
      return parseFunctionDeclaration(null);
    } else if (consume('{')) {
      pushLocation(marker);
      return parseTableConstructor();
    }
  }

  // Parser
  // ------

  // Export the main parser.
  //
  //   - `wait` Hold parsing until end() is called. Defaults to false
  //   - `comments` Store comments. Defaults to true.
  //   - `scope` Track identifier scope. Defaults to false.
  //   - `locations` Store location information. Defaults to false.
  //   - `ranges` Store the start and end character locations. Defaults to
  //     false.
  //   - `onCreateNode` Callback which will be invoked when a syntax node is
  //     created.
  //   - `onCreateScope` Callback which will be invoked when a new scope is
  //     created.
  //   - `onDestroyScope` Callback which will be invoked when the current scope
  //     is destroyed.
  //
  // Example:
  //
  //     var parser = require('luaparser');
  //     parser.parse('i = 0');

  exports.parse = parse;

  function parse(_input, _options) {
    if ('undefined' === typeof _options && 'object' === typeof _input) {
      _options = _input;
      _input = undefined;
    }
    if (!_options) _options = {};

    input = _input || '';
    options = extend(defaultOptions, _options);

    // Rewind the lexer
    index = 0;
    line = 1;
    lineStart = 0;
    length = input.length;
    // When tracking identifier scope, initialize with an empty scope.
    scopes = [[]];
    scopeDepth = 0;
    globals = [];
    locations = [];

    if (options.comments) comments = [];
    if (!options.wait) return end();
    return exports;
  }

  // Write to the source code buffer without beginning the parse.
  exports.write = write;

  function write(_input) {
    input += String(_input);
    length = input.length;
    return exports;
  }

  // Send an EOF and begin parsing.
  exports.end = end;

  function end(_input) {
    if ('undefined' !== typeof _input) write(_input);

    length = input.length;
    trackLocations = options.locations || options.ranges;
    // Initialize with a lookahead token.
    lookahead = lex();

    var chunk = parseChunk();
    if (options.comments) chunk.comments = comments;
    if (options.scope) chunk.globals = globals;

    if (locations.length > 0)
      throw new Error('Location tracking failed. This is most likely a bug in luaparse');

    return chunk;
  }

}));
/* vim: set sw=2 ts=2 et tw=79 : */

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],9:[function(require,module,exports){
module.exports=[{"type":0,"meta":0,"name":"Air","text_type":"air"},{"type":1,"meta":0,"name":"Stone","text_type":"stone"},{"type":1,"meta":1,"name":"Granite","text_type":"stone"},{"type":1,"meta":2,"name":"Polished Granite","text_type":"stone"},{"type":1,"meta":3,"name":"Diorite","text_type":"stone"},{"type":1,"meta":4,"name":"Polished Diorite","text_type":"stone"},{"type":1,"meta":5,"name":"Andesite","text_type":"stone"},{"type":1,"meta":6,"name":"Polished Andesite","text_type":"stone"},{"type":2,"meta":0,"name":"Grass","text_type":"grass"},{"type":3,"meta":0,"name":"Dirt","text_type":"dirt"},{"type":3,"meta":1,"name":"Coarse Dirt","text_type":"dirt"},{"type":3,"meta":2,"name":"Podzol","text_type":"dirt"},{"type":4,"meta":0,"name":"Cobblestone","text_type":"cobblestone"},{"type":5,"meta":0,"name":"Oak Wood Plank","text_type":"planks"},{"type":5,"meta":1,"name":"Spruce Wood Plank","text_type":"planks"},{"type":5,"meta":2,"name":"Birch Wood Plank","text_type":"planks"},{"type":5,"meta":3,"name":"Jungle Wood Plank","text_type":"planks"},{"type":5,"meta":4,"name":"Acacia Wood Plank","text_type":"planks"},{"type":5,"meta":5,"name":"Dark Oak Wood Plank","text_type":"planks"},{"type":6,"meta":0,"name":"Oak Sapling","text_type":"sapling"},{"type":6,"meta":1,"name":"Spruce Sapling","text_type":"sapling"},{"type":6,"meta":2,"name":"Birch Sapling","text_type":"sapling"},{"type":6,"meta":3,"name":"Jungle Sapling","text_type":"sapling"},{"type":6,"meta":4,"name":"Acacia Sapling","text_type":"sapling"},{"type":6,"meta":5,"name":"Dark Oak Sapling","text_type":"sapling"},{"type":7,"meta":0,"name":"Bedrock","text_type":"bedrock"},{"type":8,"meta":0,"name":"Flowing Water","text_type":"flowing_water"},{"type":9,"meta":0,"name":"Still Water","text_type":"water"},{"type":10,"meta":0,"name":"Flowing Lava","text_type":"flowing_lava"},{"type":11,"meta":0,"name":"Still Lava","text_type":"lava"},{"type":12,"meta":0,"name":"Sand","text_type":"sand"},{"type":12,"meta":1,"name":"Red Sand","text_type":"sand"},{"type":13,"meta":0,"name":"Gravel","text_type":"gravel"},{"type":14,"meta":0,"name":"Gold Ore","text_type":"gold_ore"},{"type":15,"meta":0,"name":"Iron Ore","text_type":"iron_ore"},{"type":16,"meta":0,"name":"Coal Ore","text_type":"coal_ore"},{"type":17,"meta":0,"name":"Oak Wood","text_type":"log"},{"type":17,"meta":1,"name":"Spruce Wood","text_type":"log"},{"type":17,"meta":2,"name":"Birch Wood","text_type":"log"},{"type":17,"meta":3,"name":"Jungle Wood","text_type":"log"},{"type":18,"meta":0,"name":"Oak Leaves","text_type":"leaves"},{"type":18,"meta":1,"name":"Spruce Leaves","text_type":"leaves"},{"type":18,"meta":2,"name":"Birch Leaves","text_type":"leaves"},{"type":18,"meta":3,"name":"Jungle Leaves","text_type":"leaves"},{"type":19,"meta":0,"name":"Sponge","text_type":"sponge"},{"type":19,"meta":1,"name":"Wet Sponge","text_type":"sponge"},{"type":20,"meta":0,"name":"Glass","text_type":"glass"},{"type":21,"meta":0,"name":"Lapis Lazuli Ore","text_type":"lapis_ore"},{"type":22,"meta":0,"name":"Lapis Lazuli Block","text_type":"lapis_block"},{"type":23,"meta":0,"name":"Dispenser","text_type":"dispenser"},{"type":24,"meta":0,"name":"Sandstone","text_type":"sandstone"},{"type":24,"meta":1,"name":"Chiseled Sandstone","text_type":"sandstone"},{"type":24,"meta":2,"name":"Smooth Sandstone","text_type":"sandstone"},{"type":25,"meta":0,"name":"Note Block","text_type":"noteblock"},{"type":26,"meta":0,"name":"Bed","text_type":"bed"},{"type":27,"meta":0,"name":"Powered Rail","text_type":"golden_rail"},{"type":28,"meta":0,"name":"Detector Rail","text_type":"detector_rail"},{"type":29,"meta":0,"name":"Sticky Piston","text_type":"sticky_piston"},{"type":30,"meta":0,"name":"Cobweb","text_type":"web"},{"type":31,"meta":0,"name":"Dead Shrub","text_type":"tallgrass"},{"type":31,"meta":1,"name":"Grass","text_type":"tallgrass"},{"type":31,"meta":2,"name":"Fern","text_type":"tallgrass"},{"type":32,"meta":0,"name":"Dead Bush","text_type":"deadbush"},{"type":33,"meta":0,"name":"Piston","text_type":"piston"},{"type":34,"meta":0,"name":"Piston Head","text_type":"piston_head"},{"type":35,"meta":0,"name":"White Wool","text_type":"wool"},{"type":35,"meta":1,"name":"Orange Wool","text_type":"wool"},{"type":35,"meta":2,"name":"Magenta Wool","text_type":"wool"},{"type":35,"meta":3,"name":"Light Blue Wool","text_type":"wool"},{"type":35,"meta":4,"name":"Yellow Wool","text_type":"wool"},{"type":35,"meta":5,"name":"Lime Wool","text_type":"wool"},{"type":35,"meta":6,"name":"Pink Wool","text_type":"wool"},{"type":35,"meta":7,"name":"Gray Wool","text_type":"wool"},{"type":35,"meta":8,"name":"Light Gray Wool","text_type":"wool"},{"type":35,"meta":9,"name":"Cyan Wool","text_type":"wool"},{"type":35,"meta":10,"name":"Purple Wool","text_type":"wool"},{"type":35,"meta":11,"name":"Blue Wool","text_type":"wool"},{"type":35,"meta":12,"name":"Brown Wool","text_type":"wool"},{"type":35,"meta":13,"name":"Green Wool","text_type":"wool"},{"type":35,"meta":14,"name":"Red Wool","text_type":"wool"},{"type":35,"meta":15,"name":"Black Wool","text_type":"wool"},{"type":37,"meta":0,"name":"Dandelion","text_type":"yellow_flower"},{"type":38,"meta":0,"name":"Poppy","text_type":"red_flower"},{"type":38,"meta":1,"name":"Blue Orchid","text_type":"red_flower"},{"type":38,"meta":2,"name":"Allium","text_type":"red_flower"},{"type":38,"meta":3,"name":"Azure Bluet","text_type":"red_flower"},{"type":38,"meta":4,"name":"Red Tulip","text_type":"red_flower"},{"type":38,"meta":5,"name":"Orange Tulip","text_type":"red_flower"},{"type":38,"meta":6,"name":"White Tulip","text_type":"red_flower"},{"type":38,"meta":7,"name":"Pink Tulip","text_type":"red_flower"},{"type":38,"meta":8,"name":"Oxeye Daisy","text_type":"red_flower"},{"type":39,"meta":0,"name":"Brown Mushroom","text_type":"brown_mushroom"},{"type":40,"meta":0,"name":"Red Mushroom","text_type":"red_mushroom"},{"type":41,"meta":0,"name":"Gold Block","text_type":"gold_block"},{"type":42,"meta":0,"name":"Iron Block","text_type":"iron_block"},{"type":43,"meta":0,"name":"Double Stone Slab","text_type":"double_stone_slab"},{"type":43,"meta":1,"name":"Double Sandstone Slab","text_type":"double_stone_slab"},{"type":43,"meta":2,"name":"Double Wooden Slab","text_type":"double_stone_slab"},{"type":43,"meta":3,"name":"Double Cobblestone Slab","text_type":"double_stone_slab"},{"type":43,"meta":4,"name":"Double Brick Slab","text_type":"double_stone_slab"},{"type":43,"meta":5,"name":"Double Stone Brick Slab","text_type":"double_stone_slab"},{"type":43,"meta":6,"name":"Double Nether Brick Slab","text_type":"double_stone_slab"},{"type":43,"meta":7,"name":"Double Quartz Slab","text_type":"double_stone_slab"},{"type":44,"meta":0,"name":"Stone Slab","text_type":"stone_slab"},{"type":44,"meta":1,"name":"Sandstone Slab","text_type":"stone_slab"},{"type":44,"meta":2,"name":"Wooden Slab","text_type":"stone_slab"},{"type":44,"meta":3,"name":"Cobblestone Slab","text_type":"stone_slab"},{"type":44,"meta":4,"name":"Brick Slab","text_type":"stone_slab"},{"type":44,"meta":5,"name":"Stone Brick Slab","text_type":"stone_slab"},{"type":44,"meta":6,"name":"Nether Brick Slab","text_type":"stone_slab"},{"type":44,"meta":7,"name":"Quartz Slab","text_type":"stone_slab"},{"type":45,"meta":0,"name":"Bricks","text_type":"brick_block"},{"type":46,"meta":0,"name":"TNT","text_type":"tnt"},{"type":47,"meta":0,"name":"Bookshelf","text_type":"bookshelf"},{"type":48,"meta":0,"name":"Moss Stone","text_type":"mossy_cobblestone"},{"type":49,"meta":0,"name":"Obsidian","text_type":"obsidian"},{"type":50,"meta":0,"name":"Torch","text_type":"torch"},{"type":51,"meta":0,"name":"Fire","text_type":"fire"},{"type":52,"meta":0,"name":"Monster Spawner","text_type":"mob_spawner"},{"type":53,"meta":0,"name":"Oak Wood Stairs","text_type":"oak_stairs"},{"type":54,"meta":0,"name":"Chest","text_type":"chest"},{"type":55,"meta":0,"name":"Redstone Wire","text_type":"redstone_wire"},{"type":56,"meta":0,"name":"Diamond Ore","text_type":"diamond_ore"},{"type":57,"meta":0,"name":"Diamond Block","text_type":"diamond_block"},{"type":58,"meta":0,"name":"Crafting Table","text_type":"crafting_table"},{"type":59,"meta":0,"name":"Wheat Crops","text_type":"wheat"},{"type":60,"meta":0,"name":"Farmland","text_type":"farmland"},{"type":61,"meta":0,"name":"Furnace","text_type":"furnace"},{"type":62,"meta":0,"name":"Burning Furnace","text_type":"lit_furnace"},{"type":63,"meta":0,"name":"Standing Sign Block","text_type":"standing_sign"},{"type":64,"meta":0,"name":"Oak Door Block","text_type":"wooden_door"},{"type":65,"meta":0,"name":"Ladder","text_type":"ladder"},{"type":66,"meta":0,"name":"Rail","text_type":"rail"},{"type":67,"meta":0,"name":"Cobblestone Stairs","text_type":"stone_stairs"},{"type":68,"meta":0,"name":"Wall-mounted Sign Block","text_type":"wall_sign"},{"type":69,"meta":0,"name":"Lever","text_type":"lever"},{"type":70,"meta":0,"name":"Stone Pressure Plate","text_type":"stone_pressure_plate"},{"type":71,"meta":0,"name":"Iron Door Block","text_type":"iron_door"},{"type":72,"meta":0,"name":"Wooden Pressure Plate","text_type":"wooden_pressure_plate"},{"type":73,"meta":0,"name":"Redstone Ore","text_type":"redstone_ore"},{"type":74,"meta":0,"name":"Glowing Redstone Ore","text_type":"lit_redstone_ore"},{"type":75,"meta":0,"name":"Redstone Torch (off)","text_type":"unlit_redstone_torch"},{"type":76,"meta":0,"name":"Redstone Torch (on)","text_type":"redstone_torch"},{"type":77,"meta":0,"name":"Stone Button","text_type":"stone_button"},{"type":78,"meta":0,"name":"Snow","text_type":"snow_layer"},{"type":79,"meta":0,"name":"Ice","text_type":"ice"},{"type":80,"meta":0,"name":"Snow Block","text_type":"snow"},{"type":81,"meta":0,"name":"Cactus","text_type":"cactus"},{"type":82,"meta":0,"name":"Clay","text_type":"clay"},{"type":83,"meta":0,"name":"Sugar Canes","text_type":"reeds"},{"type":84,"meta":0,"name":"Jukebox","text_type":"jukebox"},{"type":85,"meta":0,"name":"Oak Fence","text_type":"fence"},{"type":86,"meta":0,"name":"Pumpkin","text_type":"pumpkin"},{"type":87,"meta":0,"name":"Netherrack","text_type":"netherrack"},{"type":88,"meta":0,"name":"Soul Sand","text_type":"soul_sand"},{"type":89,"meta":0,"name":"Glowstone","text_type":"glowstone"},{"type":90,"meta":0,"name":"Nether Portal","text_type":"portal"},{"type":91,"meta":0,"name":"Jack o'Lantern","text_type":"lit_pumpkin"},{"type":92,"meta":0,"name":"Cake Block","text_type":"cake"},{"type":93,"meta":0,"name":"Redstone Repeater Block (off)","text_type":"unpowered_repeater"},{"type":94,"meta":0,"name":"Redstone Repeater Block (on)","text_type":"powered_repeater"},{"type":95,"meta":0,"name":"White Stained Glass","text_type":"stained_glass"},{"type":95,"meta":1,"name":"Orange Stained Glass","text_type":"stained_glass"},{"type":95,"meta":2,"name":"Magenta Stained Glass","text_type":"stained_glass"},{"type":95,"meta":3,"name":"Light Blue Stained Glass","text_type":"stained_glass"},{"type":95,"meta":4,"name":"Yellow Stained Glass","text_type":"stained_glass"},{"type":95,"meta":5,"name":"Lime Stained Glass","text_type":"stained_glass"},{"type":95,"meta":6,"name":"Pink Stained Glass","text_type":"stained_glass"},{"type":95,"meta":7,"name":"Gray Stained Glass","text_type":"stained_glass"},{"type":95,"meta":8,"name":"Light Gray Stained Glass","text_type":"stained_glass"},{"type":95,"meta":9,"name":"Cyan Stained Glass","text_type":"stained_glass"},{"type":95,"meta":10,"name":"Purple Stained Glass","text_type":"stained_glass"},{"type":95,"meta":11,"name":"Blue Stained Glass","text_type":"stained_glass"},{"type":95,"meta":12,"name":"Brown Stained Glass","text_type":"stained_glass"},{"type":95,"meta":13,"name":"Green Stained Glass","text_type":"stained_glass"},{"type":95,"meta":14,"name":"Red Stained Glass","text_type":"stained_glass"},{"type":95,"meta":15,"name":"Black Stained Glass","text_type":"stained_glass"},{"type":96,"meta":0,"name":"Wooden Trapdoor","text_type":"trapdoor"},{"type":97,"meta":0,"name":"Stone Monster Egg","text_type":"monster_egg"},{"type":97,"meta":1,"name":"Cobblestone Monster Egg","text_type":"monster_egg"},{"type":97,"meta":2,"name":"Stone Brick Monster Egg","text_type":"monster_egg"},{"type":97,"meta":3,"name":"Mossy Stone Brick Monster Egg","text_type":"monster_egg"},{"type":97,"meta":4,"name":"Cracked Stone Brick Monster Egg","text_type":"monster_egg"},{"type":97,"meta":5,"name":"Chiseled Stone Brick Monster Egg","text_type":"monster_egg"},{"type":98,"meta":0,"name":"Stone Bricks","text_type":"stonebrick"},{"type":98,"meta":1,"name":"Mossy Stone Bricks","text_type":"stonebrick"},{"type":98,"meta":2,"name":"Cracked Stone Bricks","text_type":"stonebrick"},{"type":98,"meta":3,"name":"Chiseled Stone Bricks","text_type":"stonebrick"},{"type":99,"meta":0,"name":"Brown Mushroom Block","text_type":"brown_mushroom_block"},{"type":100,"meta":0,"name":"Red Mushroom Block","text_type":"red_mushroom_block"},{"type":101,"meta":0,"name":"Iron Bars","text_type":"iron_bars"},{"type":102,"meta":0,"name":"Glass Pane","text_type":"glass_pane"},{"type":103,"meta":0,"name":"Melon Block","text_type":"melon_block"},{"type":104,"meta":0,"name":"Pumpkin Stem","text_type":"pumpkin_stem"},{"type":105,"meta":0,"name":"Melon Stem","text_type":"melon_stem"},{"type":106,"meta":0,"name":"Vines","text_type":"vine"},{"type":107,"meta":0,"name":"Oak Fence Gate","text_type":"fence_gate"},{"type":108,"meta":0,"name":"Brick Stairs","text_type":"brick_stairs"},{"type":109,"meta":0,"name":"Stone Brick Stairs","text_type":"stone_brick_stairs"},{"type":110,"meta":0,"name":"Mycelium","text_type":"mycelium"},{"type":111,"meta":0,"name":"Lily Pad","text_type":"waterlily"},{"type":112,"meta":0,"name":"Nether Brick","text_type":"nether_brick"},{"type":113,"meta":0,"name":"Nether Brick Fence","text_type":"nether_brick_fence"},{"type":114,"meta":0,"name":"Nether Brick Stairs","text_type":"nether_brick_stairs"},{"type":115,"meta":0,"name":"Nether Wart","text_type":"nether_wart"},{"type":116,"meta":0,"name":"Enchantment Table","text_type":"enchanting_table"},{"type":117,"meta":0,"name":"Brewing Stand","text_type":"brewing_stand"},{"type":118,"meta":0,"name":"Cauldron","text_type":"cauldron"},{"type":119,"meta":0,"name":"End Portal","text_type":"end_portal"},{"type":120,"meta":0,"name":"End Portal Frame","text_type":"end_portal_frame"},{"type":121,"meta":0,"name":"End Stone","text_type":"end_stone"},{"type":122,"meta":0,"name":"Dragon Egg","text_type":"dragon_egg"},{"type":123,"meta":0,"name":"Redstone Lamp (inactive)","text_type":"redstone_lamp"},{"type":124,"meta":0,"name":"Redstone Lamp (active)","text_type":"lit_redstone_lamp"},{"type":125,"meta":0,"name":"Double Oak Wood Slab","text_type":"double_wooden_slab"},{"type":125,"meta":1,"name":"Double Spruce Wood Slab","text_type":"double_wooden_slab"},{"type":125,"meta":2,"name":"Double Birch Wood Slab","text_type":"double_wooden_slab"},{"type":125,"meta":3,"name":"Double Jungle Wood Slab","text_type":"double_wooden_slab"},{"type":125,"meta":4,"name":"Double Acacia Wood Slab","text_type":"double_wooden_slab"},{"type":125,"meta":5,"name":"Double Dark Oak Wood Slab","text_type":"double_wooden_slab"},{"type":126,"meta":0,"name":"Oak Wood Slab","text_type":"wooden_slab"},{"type":126,"meta":1,"name":"Spruce Wood Slab","text_type":"wooden_slab"},{"type":126,"meta":2,"name":"Birch Wood Slab","text_type":"wooden_slab"},{"type":126,"meta":3,"name":"Jungle Wood Slab","text_type":"wooden_slab"},{"type":126,"meta":4,"name":"Acacia Wood Slab","text_type":"wooden_slab"},{"type":126,"meta":5,"name":"Dark Oak Wood Slab","text_type":"wooden_slab"},{"type":127,"meta":0,"name":"Cocoa","text_type":"cocoa"},{"type":128,"meta":0,"name":"Sandstone Stairs","text_type":"sandstone_stairs"},{"type":129,"meta":0,"name":"Emerald Ore","text_type":"emerald_ore"},{"type":130,"meta":0,"name":"Ender Chest","text_type":"ender_chest"},{"type":131,"meta":0,"name":"Tripwire Hook","text_type":"tripwire_hook"},{"type":132,"meta":0,"name":"Tripwire","text_type":"tripwire_hook"},{"type":133,"meta":0,"name":"Emerald Block","text_type":"emerald_block"},{"type":134,"meta":0,"name":"Spruce Wood Stairs","text_type":"spruce_stairs"},{"type":135,"meta":0,"name":"Birch Wood Stairs","text_type":"birch_stairs"},{"type":136,"meta":0,"name":"Jungle Wood Stairs","text_type":"jungle_stairs"},{"type":137,"meta":0,"name":"Command Block","text_type":"command_block"},{"type":138,"meta":0,"name":"Beacon","text_type":"beacon"},{"type":139,"meta":0,"name":"Cobblestone Wall","text_type":"cobblestone_wall"},{"type":139,"meta":1,"name":"Mossy Cobblestone Wall","text_type":"cobblestone_wall"},{"type":140,"meta":0,"name":"Flower Pot","text_type":"flower_pot"},{"type":141,"meta":0,"name":"Carrots","text_type":"carrots"},{"type":142,"meta":0,"name":"Potatoes","text_type":"potatoes"},{"type":143,"meta":0,"name":"Wooden Button","text_type":"wooden_button"},{"type":144,"meta":0,"name":"Mob Head","text_type":"skull"},{"type":145,"meta":0,"name":"Anvil","text_type":"anvil"},{"type":146,"meta":0,"name":"Trapped Chest","text_type":"trapped_chest"},{"type":147,"meta":0,"name":"Weighted Pressure Plate (light)","text_type":"light_weighted_pressure_plate"},{"type":148,"meta":0,"name":"Weighted Pressure Plate (heavy)","text_type":"heavy_weighted_pressure_plate"},{"type":149,"meta":0,"name":"Redstone Comparator (inactive)","text_type":"unpowered_comparator"},{"type":150,"meta":0,"name":"Redstone Comparator (active)","text_type":"powered_comparator"},{"type":151,"meta":0,"name":"Daylight Sensor","text_type":"daylight_detector"},{"type":152,"meta":0,"name":"Redstone Block","text_type":"redstone_block"},{"type":153,"meta":0,"name":"Nether Quartz Ore","text_type":"quartz_ore"},{"type":154,"meta":0,"name":"Hopper","text_type":"hopper"},{"type":155,"meta":0,"name":"Quartz Block","text_type":"quartz_block"},{"type":155,"meta":1,"name":"Chiseled Quartz Block","text_type":"quartz_block"},{"type":155,"meta":2,"name":"Pillar Quartz Block","text_type":"quartz_block"},{"type":156,"meta":0,"name":"Quartz Stairs","text_type":"quartz_stairs"},{"type":157,"meta":0,"name":"Activator Rail","text_type":"activator_rail"},{"type":158,"meta":0,"name":"Dropper","text_type":"dropper"},{"type":159,"meta":0,"name":"White Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":1,"name":"Orange Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":2,"name":"Magenta Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":3,"name":"Light Blue Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":4,"name":"Yellow Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":5,"name":"Lime Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":6,"name":"Pink Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":7,"name":"Gray Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":8,"name":"Light Gray Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":9,"name":"Cyan Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":10,"name":"Purple Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":11,"name":"Blue Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":12,"name":"Brown Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":13,"name":"Green Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":14,"name":"Red Stained Clay","text_type":"stained_hardened_clay"},{"type":159,"meta":15,"name":"Black Stained Clay","text_type":"stained_hardened_clay"},{"type":160,"meta":0,"name":"White Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":1,"name":"Orange Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":2,"name":"Magenta Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":3,"name":"Light Blue Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":4,"name":"Yellow Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":5,"name":"Lime Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":6,"name":"Pink Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":7,"name":"Gray Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":8,"name":"Light Gray Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":9,"name":"Cyan Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":10,"name":"Purple Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":11,"name":"Blue Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":12,"name":"Brown Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":13,"name":"Green Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":14,"name":"Red Stained Glass Pane","text_type":"stained_glass_pane"},{"type":160,"meta":15,"name":"Black Stained Glass Pane","text_type":"stained_glass_pane"},{"type":161,"meta":0,"name":"Acacia Leaves","text_type":"leaves2"},{"type":161,"meta":1,"name":"Dark Oak Leaves","text_type":"leaves2"},{"type":162,"meta":0,"name":"Acacia Wood","text_type":"log2"},{"type":162,"meta":1,"name":"Dark Oak Wood","text_type":"log2"},{"type":163,"meta":0,"name":"Acacia Wood Stairs","text_type":"acacia_stairs"},{"type":164,"meta":0,"name":"Dark Oak Wood Stairs","text_type":"dark_oak_stairs"},{"type":165,"meta":0,"name":"Slime Block","text_type":"slime"},{"type":166,"meta":0,"name":"Barrier","text_type":"barrier"},{"type":167,"meta":0,"name":"Iron Trapdoor","text_type":"iron_trapdoor"},{"type":168,"meta":0,"name":"Prismarine","text_type":"prismarine"},{"type":168,"meta":1,"name":"Prismarine Bricks","text_type":"prismarine"},{"type":168,"meta":2,"name":"Dark Prismarine","text_type":"prismarine"},{"type":169,"meta":0,"name":"Sea Lantern","text_type":"sea_lantern"},{"type":170,"meta":0,"name":"Hay Bale","text_type":"hay_block"},{"type":171,"meta":0,"name":"White Carpet","text_type":"carpet"},{"type":171,"meta":1,"name":"Orange Carpet","text_type":"carpet"},{"type":171,"meta":2,"name":"Magenta Carpet","text_type":"carpet"},{"type":171,"meta":3,"name":"Light Blue Carpet","text_type":"carpet"},{"type":171,"meta":4,"name":"Yellow Carpet","text_type":"carpet"},{"type":171,"meta":5,"name":"Lime Carpet","text_type":"carpet"},{"type":171,"meta":6,"name":"Pink Carpet","text_type":"carpet"},{"type":171,"meta":7,"name":"Gray Carpet","text_type":"carpet"},{"type":171,"meta":8,"name":"Light Gray Carpet","text_type":"carpet"},{"type":171,"meta":9,"name":"Cyan Carpet","text_type":"carpet"},{"type":171,"meta":10,"name":"Purple Carpet","text_type":"carpet"},{"type":171,"meta":11,"name":"Blue Carpet","text_type":"carpet"},{"type":171,"meta":12,"name":"Brown Carpet","text_type":"carpet"},{"type":171,"meta":13,"name":"Green Carpet","text_type":"carpet"},{"type":171,"meta":14,"name":"Red Carpet","text_type":"carpet"},{"type":171,"meta":15,"name":"Black Carpet","text_type":"carpet"},{"type":172,"meta":0,"name":"Hardened Clay","text_type":"hardened_clay"},{"type":173,"meta":0,"name":"Block of Coal","text_type":"coal_block"},{"type":174,"meta":0,"name":"Packed Ice","text_type":"packed_ice"},{"type":175,"meta":0,"name":"Sunflower","text_type":"double_plant"},{"type":175,"meta":1,"name":"Lilac","text_type":"double_plant"},{"type":175,"meta":2,"name":"Double Tallgrass","text_type":"double_plant"},{"type":175,"meta":3,"name":"Large Fern","text_type":"double_plant"},{"type":175,"meta":4,"name":"Rose Bush","text_type":"double_plant"},{"type":175,"meta":5,"name":"Peony","text_type":"double_plant"},{"type":176,"meta":0,"name":"Free-standing Banner","text_type":"standing_banner"},{"type":177,"meta":0,"name":"Wall-mounted Banner","text_type":"wall_banner"},{"type":178,"meta":0,"name":"Inverted Daylight Sensor","text_type":"daylight_detector_inverted"},{"type":179,"meta":0,"name":"Red Sandstone","text_type":"red_sandstone"},{"type":179,"meta":1,"name":"Chiseled Red Sandstone","text_type":"red_sandstone"},{"type":179,"meta":2,"name":"Smooth Red Sandstone","text_type":"red_sandstone"},{"type":180,"meta":0,"name":"Red Sandstone Stairs","text_type":"red_sandstone_stairs"},{"type":181,"meta":0,"name":"Double Red Sandstone Slab","text_type":"stone_slab2"},{"type":182,"meta":0,"name":"Red Sandstone Slab","text_type":"double_stone_slab2"},{"type":183,"meta":0,"name":"Spruce Fence Gate","text_type":"spruce_fence_gate"},{"type":184,"meta":0,"name":"Birch Fence Gate","text_type":"birch_fence_gate"},{"type":185,"meta":0,"name":"Jungle Fence Gate","text_type":"jungle_fence_gate"},{"type":186,"meta":0,"name":"Dark Oak Fence Gate","text_type":"dark_oak_fence_gate"},{"type":187,"meta":0,"name":"Acacia Fence Gate","text_type":"acacia_fence_gate"},{"type":188,"meta":0,"name":"Spruce Fence","text_type":"spruce_fence"},{"type":189,"meta":0,"name":"Birch Fence","text_type":"birch_fence"},{"type":190,"meta":0,"name":"Jungle Fence","text_type":"jungle_fence"},{"type":191,"meta":0,"name":"Dark Oak Fence","text_type":"dark_oak_fence"},{"type":192,"meta":0,"name":"Acacia Fence","text_type":"acacia_fence"},{"type":193,"meta":0,"name":"Spruce Door Block","text_type":"spruce_door"},{"type":194,"meta":0,"name":"Birch Door Block","text_type":"birch_door"},{"type":195,"meta":0,"name":"Jungle Door Block","text_type":"jungle_door"},{"type":196,"meta":0,"name":"Acacia Door Block","text_type":"acacia_door"},{"type":197,"meta":0,"name":"Dark Oak Door Block","text_type":"dark_oak_door"},{"type":256,"meta":0,"name":"Iron Shovel","text_type":"iron_shovel"},{"type":257,"meta":0,"name":"Iron Pickaxe","text_type":"iron_pickaxe"},{"type":258,"meta":0,"name":"Iron Axe","text_type":"iron_axe"},{"type":259,"meta":0,"name":"Flint and Steel","text_type":"flint_and_steel"},{"type":260,"meta":0,"name":"Apple","text_type":"apple"},{"type":261,"meta":0,"name":"Bow","text_type":"bow"},{"type":262,"meta":0,"name":"Arrow","text_type":"arrow"},{"type":263,"meta":0,"name":"Coal","text_type":"coal"},{"type":263,"meta":1,"name":"Charcoal","text_type":"coal"},{"type":264,"meta":0,"name":"Diamond","text_type":"diamond"},{"type":265,"meta":0,"name":"Iron Ingot","text_type":"iron_ingot"},{"type":266,"meta":0,"name":"Gold Ingot","text_type":"gold_ingot"},{"type":267,"meta":0,"name":"Iron Sword","text_type":"iron_sword"},{"type":268,"meta":0,"name":"Wooden Sword","text_type":"wooden_sword"},{"type":269,"meta":0,"name":"Wooden Shovel","text_type":"wooden_shovel"},{"type":270,"meta":0,"name":"Wooden Pickaxe","text_type":"wooden_pickaxe"},{"type":271,"meta":0,"name":"Wooden Axe","text_type":"wooden_axe"},{"type":272,"meta":0,"name":"Stone Sword","text_type":"stone_sword"},{"type":273,"meta":0,"name":"Stone Shovel","text_type":"stone_shovel"},{"type":274,"meta":0,"name":"Stone Pickaxe","text_type":"stone_pickaxe"},{"type":275,"meta":0,"name":"Stone Axe","text_type":"stone_axe"},{"type":276,"meta":0,"name":"Diamond Sword","text_type":"diamond_sword"},{"type":277,"meta":0,"name":"Diamond Shovel","text_type":"diamond_shovel"},{"type":278,"meta":0,"name":"Diamond Pickaxe","text_type":"diamond_pickaxe"},{"type":279,"meta":0,"name":"Diamond Axe","text_type":"diamond_axe"},{"type":280,"meta":0,"name":"Stick","text_type":"stick"},{"type":281,"meta":0,"name":"Bowl","text_type":"bowl"},{"type":282,"meta":0,"name":"Mushroom Stew","text_type":"mushroom_stew"},{"type":283,"meta":0,"name":"Golden Sword","text_type":"golden_sword"},{"type":284,"meta":0,"name":"Golden Shovel","text_type":"golden_shovel"},{"type":285,"meta":0,"name":"Golden Pickaxe","text_type":"golden_pickaxe"},{"type":286,"meta":0,"name":"Golden Axe","text_type":"golden_axe"},{"type":287,"meta":0,"name":"String","text_type":"string"},{"type":288,"meta":0,"name":"Feather","text_type":"feather"},{"type":289,"meta":0,"name":"Gunpowder","text_type":"gunpowder"},{"type":290,"meta":0,"name":"Wooden Hoe","text_type":"wooden_hoe"},{"type":291,"meta":0,"name":"Stone Hoe","text_type":"stone_hoe"},{"type":292,"meta":0,"name":"Iron Hoe","text_type":"iron_hoe"},{"type":293,"meta":0,"name":"Diamond Hoe","text_type":"diamond_hoe"},{"type":294,"meta":0,"name":"Golden Hoe","text_type":"golden_hoe"},{"type":295,"meta":0,"name":"Wheat Seeds","text_type":"wheat_seeds"},{"type":296,"meta":0,"name":"Wheat","text_type":"wheat"},{"type":297,"meta":0,"name":"Bread","text_type":"bread"},{"type":298,"meta":0,"name":"Leather Helmet","text_type":"leather_helmet"},{"type":299,"meta":0,"name":"Leather Tunic","text_type":"leather_chestplate"},{"type":300,"meta":0,"name":"Leather Pants","text_type":"leather_leggings"},{"type":301,"meta":0,"name":"Leather Boots","text_type":"leather_boots"},{"type":302,"meta":0,"name":"Chainmail Helmet","text_type":"chainmail_helmet"},{"type":303,"meta":0,"name":"Chainmail Chestplate","text_type":"chainmail_chestplate"},{"type":304,"meta":0,"name":"Chainmail Leggings","text_type":"chainmail_leggings"},{"type":305,"meta":0,"name":"Chainmail Boots","text_type":"chainmail_boots"},{"type":306,"meta":0,"name":"Iron Helmet","text_type":"iron_helmet"},{"type":307,"meta":0,"name":"Iron Chestplate","text_type":"iron_chestplate"},{"type":308,"meta":0,"name":"Iron Leggings","text_type":"iron_leggings"},{"type":309,"meta":0,"name":"Iron Boots","text_type":"iron_boots"},{"type":310,"meta":0,"name":"Diamond Helmet","text_type":"diamond_helmet"},{"type":311,"meta":0,"name":"Diamond Chestplate","text_type":"diamond_chestplate"},{"type":312,"meta":0,"name":"Diamond Leggings","text_type":"diamond_leggings"},{"type":313,"meta":0,"name":"Diamond Boots","text_type":"diamond_boots"},{"type":314,"meta":0,"name":"Golden Helmet","text_type":"golden_helmet"},{"type":315,"meta":0,"name":"Golden Chestplate","text_type":"golden_chestplate"},{"type":316,"meta":0,"name":"Golden Leggings","text_type":"golden_leggings"},{"type":317,"meta":0,"name":"Golden Boots","text_type":"golden_boots"},{"type":318,"meta":0,"name":"Flint","text_type":"flint"},{"type":319,"meta":0,"name":"Raw Porkchop","text_type":"porkchop"},{"type":320,"meta":0,"name":"Cooked Porkchop","text_type":"cooked_porkchop"},{"type":321,"meta":0,"name":"Painting","text_type":"painting"},{"type":322,"meta":0,"name":"Golden Apple","text_type":"golden_apple"},{"type":322,"meta":1,"name":"Enchanted Golden Apple","text_type":"golden_apple"},{"type":323,"meta":0,"name":"Sign","text_type":"sign"},{"type":324,"meta":0,"name":"Oak Door","text_type":"wooden_door"},{"type":325,"meta":0,"name":"Bucket","text_type":"bucket"},{"type":326,"meta":0,"name":"Water Bucket","text_type":"water_bucket"},{"type":327,"meta":0,"name":"Lava Bucket","text_type":"lava_bucket"},{"type":328,"meta":0,"name":"Minecart","text_type":"minecart"},{"type":329,"meta":0,"name":"Saddle","text_type":"saddle"},{"type":330,"meta":0,"name":"Iron Door","text_type":"iron_door"},{"type":331,"meta":0,"name":"Redstone","text_type":"redstone"},{"type":332,"meta":0,"name":"Snowball","text_type":"snowball"},{"type":333,"meta":0,"name":"Boat","text_type":"boat"},{"type":334,"meta":0,"name":"Leather","text_type":"leather"},{"type":335,"meta":0,"name":"Milk Bucket","text_type":"milk_bucket"},{"type":336,"meta":0,"name":"Brick","text_type":"brick"},{"type":337,"meta":0,"name":"Clay","text_type":"clay_ball"},{"type":338,"meta":0,"name":"Sugar Canes","text_type":"reeds"},{"type":339,"meta":0,"name":"Paper","text_type":"paper"},{"type":340,"meta":0,"name":"Book","text_type":"book"},{"type":341,"meta":0,"name":"Slimeball","text_type":"slime_ball"},{"type":342,"meta":0,"name":"Minecart with Chest","text_type":"chest_minecart"},{"type":343,"meta":0,"name":"Minecart with Furnace","text_type":"furnace_minecart"},{"type":344,"meta":0,"name":"Egg","text_type":"egg"},{"type":345,"meta":0,"name":"Compass","text_type":"compass"},{"type":346,"meta":0,"name":"Fishing Rod","text_type":"fishing_rod"},{"type":347,"meta":0,"name":"Clock","text_type":"clock"},{"type":348,"meta":0,"name":"Glowstone Dust","text_type":"glowstone_dust"},{"type":349,"meta":0,"name":"Raw Fish","text_type":"fish"},{"type":349,"meta":1,"name":"Raw Salmon","text_type":"fish"},{"type":349,"meta":2,"name":"Clownfish","text_type":"fish"},{"type":349,"meta":3,"name":"Pufferfish","text_type":"fish"},{"type":350,"meta":0,"name":"Cooked Fish","text_type":"cooked_fish"},{"type":350,"meta":1,"name":"Cooked Salmon","text_type":"cooked_fish"},{"type":351,"meta":0,"name":"Ink Sack","text_type":"dye"},{"type":351,"meta":1,"name":"Rose Red","text_type":"dye"},{"type":351,"meta":2,"name":"Cactus Green","text_type":"dye"},{"type":351,"meta":3,"name":"Coco Beans","text_type":"dye"},{"type":351,"meta":4,"name":"Lapis Lazuli","text_type":"dye"},{"type":351,"meta":5,"name":"Purple Dye","text_type":"dye"},{"type":351,"meta":6,"name":"Cyan Dye","text_type":"dye"},{"type":351,"meta":7,"name":"Light Gray Dye","text_type":"dye"},{"type":351,"meta":8,"name":"Gray Dye","text_type":"dye"},{"type":351,"meta":9,"name":"Pink Dye","text_type":"dye"},{"type":351,"meta":10,"name":"Lime Dye","text_type":"dye"},{"type":351,"meta":11,"name":"Dandelion Yellow","text_type":"dye"},{"type":351,"meta":12,"name":"Light Blue Dye","text_type":"dye"},{"type":351,"meta":13,"name":"Magenta Dye","text_type":"dye"},{"type":351,"meta":14,"name":"Orange Dye","text_type":"dye"},{"type":351,"meta":15,"name":"Bone Meal","text_type":"dye"},{"type":352,"meta":0,"name":"Bone","text_type":"bone"},{"type":353,"meta":0,"name":"Sugar","text_type":"sugar"},{"type":354,"meta":0,"name":"Cake","text_type":"cake"},{"type":355,"meta":0,"name":"Bed","text_type":"bed"},{"type":356,"meta":0,"name":"Redstone Repeater","text_type":"repeater"},{"type":357,"meta":0,"name":"Cookie","text_type":"cookie"},{"type":358,"meta":0,"name":"Map","text_type":"filled_map"},{"type":359,"meta":0,"name":"Shears","text_type":"shears"},{"type":360,"meta":0,"name":"Melon","text_type":"melon"},{"type":361,"meta":0,"name":"Pumpkin Seeds","text_type":"pumpkin_seeds"},{"type":362,"meta":0,"name":"Melon Seeds","text_type":"melon_seeds"},{"type":363,"meta":0,"name":"Raw Beef","text_type":"beef"},{"type":364,"meta":0,"name":"Steak","text_type":"cooked_beef"},{"type":365,"meta":0,"name":"Raw Chicken","text_type":"chicken"},{"type":366,"meta":0,"name":"Cooked Chicken","text_type":"cooked_chicken"},{"type":367,"meta":0,"name":"Rotten Flesh","text_type":"rotten_flesh"},{"type":368,"meta":0,"name":"Ender Pearl","text_type":"ender_pearl"},{"type":369,"meta":0,"name":"Blaze Rod","text_type":"blaze_rod"},{"type":370,"meta":0,"name":"Ghast Tear","text_type":"ghast_tear"},{"type":371,"meta":0,"name":"Gold Nugget","text_type":"gold_nugget"},{"type":372,"meta":0,"name":"Nether Wart","text_type":"nether_wart"},{"type":373,"meta":0,"name":"Potion","text_type":"potion"},{"type":374,"meta":0,"name":"Glass Bottle","text_type":"glass_bottle"},{"type":375,"meta":0,"name":"Spider Eye","text_type":"spider_eye"},{"type":376,"meta":0,"name":"Fermented Spider Eye","text_type":"fermented_spider_eye"},{"type":377,"meta":0,"name":"Blaze Powder","text_type":"blaze_powder"},{"type":378,"meta":0,"name":"Magma Cream","text_type":"magma_cream"},{"type":379,"meta":0,"name":"Brewing Stand","text_type":"brewing_stand"},{"type":380,"meta":0,"name":"Cauldron","text_type":"cauldron"},{"type":381,"meta":0,"name":"Eye of Ender","text_type":"ender_eye"},{"type":382,"meta":0,"name":"Glistering Melon","text_type":"speckled_melon"},{"type":383,"meta":50,"name":"Spawn Creeper","text_type":"spawn_egg"},{"type":383,"meta":51,"name":"Spawn Skeleton","text_type":"spawn_egg"},{"type":383,"meta":52,"name":"Spawn Spider","text_type":"spawn_egg"},{"type":383,"meta":54,"name":"Spawn Zombie","text_type":"spawn_egg"},{"type":383,"meta":55,"name":"Spawn Slime","text_type":"spawn_egg"},{"type":383,"meta":56,"name":"Spawn Ghast","text_type":"spawn_egg"},{"type":383,"meta":57,"name":"Spawn Pigman","text_type":"spawn_egg"},{"type":383,"meta":58,"name":"Spawn Enderman","text_type":"spawn_egg"},{"type":383,"meta":59,"name":"Spawn Cave Spider","text_type":"spawn_egg"},{"type":383,"meta":60,"name":"Spawn Silverfish","text_type":"spawn_egg"},{"type":383,"meta":61,"name":"Spawn Blaze","text_type":"spawn_egg"},{"type":383,"meta":62,"name":"Spawn Magma Cube","text_type":"spawn_egg"},{"type":383,"meta":65,"name":"Spawn Bat","text_type":"spawn_egg"},{"type":383,"meta":66,"name":"Spawn Witch","text_type":"spawn_egg"},{"type":383,"meta":67,"name":"Spawn Endermite","text_type":"spawn_egg"},{"type":383,"meta":68,"name":"Spawn Guardian","text_type":"spawn_egg"},{"type":383,"meta":90,"name":"Spawn Pig","text_type":"spawn_egg"},{"type":383,"meta":91,"name":"Spawn Sheep","text_type":"spawn_egg"},{"type":383,"meta":92,"name":"Spawn Cow","text_type":"spawn_egg"},{"type":383,"meta":93,"name":"Spawn Chicken","text_type":"spawn_egg"},{"type":383,"meta":94,"name":"Spawn Squid","text_type":"spawn_egg"},{"type":383,"meta":95,"name":"Spawn Wolf","text_type":"spawn_egg"},{"type":383,"meta":96,"name":"Spawn Mooshroom","text_type":"spawn_egg"},{"type":383,"meta":98,"name":"Spawn Ocelot","text_type":"spawn_egg"},{"type":383,"meta":100,"name":"Spawn Horse","text_type":"spawn_egg"},{"type":383,"meta":101,"name":"Spawn Rabbit","text_type":"spawn_egg"},{"type":383,"meta":120,"name":"Spawn Villager","text_type":"spawn_egg"},{"type":384,"meta":0,"name":"Bottle o' Enchanting","text_type":"experience_bottle"},{"type":385,"meta":0,"name":"Fire Charge","text_type":"fire_charge"},{"type":386,"meta":0,"name":"Book and Quill","text_type":"writable_book"},{"type":387,"meta":0,"name":"Written Book","text_type":"written_book"},{"type":388,"meta":0,"name":"Emerald","text_type":"emerald"},{"type":389,"meta":0,"name":"Item Frame","text_type":"item_frame"},{"type":390,"meta":0,"name":"Flower Pot","text_type":"flower_pot"},{"type":391,"meta":0,"name":"Carrot","text_type":"carrot"},{"type":392,"meta":0,"name":"Potato","text_type":"potato"},{"type":393,"meta":0,"name":"Baked Potato","text_type":"baked_potato"},{"type":394,"meta":0,"name":"Poisonous Potato","text_type":"poisonous_potato"},{"type":395,"meta":0,"name":"Empty Map","text_type":"map"},{"type":396,"meta":0,"name":"Golden Carrot","text_type":"golden_carrot"},{"type":397,"meta":0,"name":"Mob Head (Skeleton)","text_type":"skull"},{"type":397,"meta":1,"name":"Mob Head (Wither Skeleton)","text_type":"skull"},{"type":397,"meta":2,"name":"Mob Head (Zombie)","text_type":"skull"},{"type":397,"meta":3,"name":"Mob Head (Human)","text_type":"skull"},{"type":397,"meta":4,"name":"Mob Head (Creeper)","text_type":"skull"},{"type":398,"meta":0,"name":"Carrot on a Stick","text_type":"carrot_on_a_stick"},{"type":399,"meta":0,"name":"Nether Star","text_type":"nether_star"},{"type":400,"meta":0,"name":"Pumpkin Pie","text_type":"pumpkin_pie"},{"type":401,"meta":0,"name":"Firework Rocket","text_type":"fireworks"},{"type":402,"meta":0,"name":"Firework Star","text_type":"firework_charge"},{"type":403,"meta":0,"name":"Enchanted Book","text_type":"enchanted_book"},{"type":404,"meta":0,"name":"Redstone Comparator","text_type":"comparator"},{"type":405,"meta":0,"name":"Nether Brick","text_type":"netherbrick"},{"type":406,"meta":0,"name":"Nether Quartz","text_type":"quartz"},{"type":407,"meta":0,"name":"Minecart with TNT","text_type":"tnt_minecart"},{"type":408,"meta":0,"name":"Minecart with Hopper","text_type":"hopper_minecart"},{"type":409,"meta":0,"name":"Prismarine Shard","text_type":"prismarine_shard"},{"type":410,"meta":0,"name":"Prismarine Crystals","text_type":"prismarine_crystals"},{"type":411,"meta":0,"name":"Raw Rabbit","text_type":"rabbit"},{"type":412,"meta":0,"name":"Cooked Rabbit","text_type":"cooked_rabbit"},{"type":413,"meta":0,"name":"Rabbit Stew","text_type":"rabbit_stew"},{"type":414,"meta":0,"name":"Rabbit's Foot","text_type":"rabbit_foot"},{"type":415,"meta":0,"name":"Rabbit Hide","text_type":"rabbit_hide"},{"type":416,"meta":0,"name":"Armor Stand","text_type":"armor_stand"},{"type":417,"meta":0,"name":"Iron Horse Armor","text_type":"iron_horse_armor"},{"type":418,"meta":0,"name":"Golden Horse Armor","text_type":"golden_horse_armor"},{"type":419,"meta":0,"name":"Diamond Horse Armor","text_type":"diamond_horse_armor"},{"type":420,"meta":0,"name":"Lead","text_type":"lead"},{"type":421,"meta":0,"name":"Name Tag","text_type":"name_tag"},{"type":422,"meta":0,"name":"Minecart with Command Block","text_type":"command_block_minecart"},{"type":423,"meta":0,"name":"Raw Mutton","text_type":"mutton"},{"type":424,"meta":0,"name":"Cooked Mutton","text_type":"cooked_mutton"},{"type":425,"meta":0,"name":"Banner","text_type":"banner"},{"type":427,"meta":0,"name":"Spruce Door","text_type":"spruce_door"},{"type":428,"meta":0,"name":"Birch Door","text_type":"birch_door"},{"type":429,"meta":0,"name":"Jungle Door","text_type":"jungle_door"},{"type":430,"meta":0,"name":"Acacia Door","text_type":"acacia_door"},{"type":431,"meta":0,"name":"Dark Oak Door","text_type":"dark_oak_door"},{"type":2256,"meta":0,"name":"13 Disc","text_type":"record_13"},{"type":2257,"meta":0,"name":"Cat Disc","text_type":"record_cat"},{"type":2258,"meta":0,"name":"Blocks Disc","text_type":"record_blocks"},{"type":2259,"meta":0,"name":"Chirp Disc","text_type":"record_chirp"},{"type":2260,"meta":0,"name":"Far Disc","text_type":"record_far"},{"type":2261,"meta":0,"name":"Mall Disc","text_type":"record_mall"},{"type":2262,"meta":0,"name":"Mellohi Disc","text_type":"record_mellohi"},{"type":2263,"meta":0,"name":"Stal Disc","text_type":"record_stal"},{"type":2264,"meta":0,"name":"Strad Disc","text_type":"record_strad"},{"type":2265,"meta":0,"name":"Ward Disc","text_type":"record_ward"},{"type":2266,"meta":0,"name":"11 Disc","text_type":"record_11"},{"type":2267,"meta":0,"name":"Wait Disc","text_type":"record_wait"}]
},{}],10:[function(require,module,exports){
(function (Buffer){
var itemIds = require("./itemIds.json");
var tagNames = {};
for(var i = 0; i < itemIds.length; i++)
{
    tagNames[itemIds[i].text_type] = itemIds[i].type;
}

module.exports = function(blocks, cmdBlocks, callback)
{
    console.log("Outputting as schematic to " + options.schematic_file);

    var blockCount = blocks.length + cmdBlocks.length;
    var width = options.length || 20;
    var height = 1;
    var length = Math.ceil(blockCount / 20);

    var tileEntities = [];
    var _blocks = new Array(blockCount);
    var data = new Array(blockCount);

    _blocks.fill(0);
    data.fill(0);

    for(var i = 0; i < blocks.length; i++)
    {
        var adress = (blocks[i].y * length + blocks[i].z) * width + blocks[i].x;
        var itemId = tagNames[blocks[i].tagName];

        _blocks[adress] = itemId;
        data[adress] = blocks[i].data & 0x0f;
    }
    for(var i = 0; i < cmdBlocks.length; i++) //{x: x, y: y, z: z, data: blockData, command: blocks[i].command}
    {
        var adress = (cmdBlocks[i].y * length + cmdBlocks[i].z) * width + cmdBlocks[i].x;

        _blocks[adress] = 211; //chain commandblock currently no in the item id list
        data[adress] =  cmdBlocks[i].data & 0x0f;

        tileEntities.push({
            Command: cmdBlocks[i].command,
            auto: 1,
            id: "Control",
            x: cmdBlocks[i].x,
            y: cmdBlocks[i].y,
            z: cmdBlocks[i].z
        });
    }

    var data = {
        rootName: "Schematic",
        root: {
            Width: width,
            Height: height,
            Length: length,
            Materials: "Alpha",
            Blocks: _blocks,
            Data: data,
            Entities: [],
            TileEntities: tileEntities
        }
    };

    schema.TileEntities = new Array(tileEntities.length);
    schema.TileEntities.fill(controlSchema);

    toNBT(data, schema, function(err, _data)
    {
        if(callback)
        {
            callback(err, _data);
        }
        else
        {
            if(err)
                throw err;

            require("fs").writeFileSync(options.schematic_file, _data);
        }
    });
}

var tags = [
    "end",
    "byte",
    "short",
    "int",
    "long",
    "float",
    "double",
    "byteArray",
    "string",
    "list",
    "compound",
    "intArray"
];
function tagId(name)
{
    return tags.indexOf(name);
}
var schema = {
    Width: tagId("short"),
    Height: tagId("short"),
    Length: tagId("short"),
    Materials: tagId("string"),
    Blocks: tagId("byteArray"),
    Data: tagId("byteArray"),
    Entities: [
        {}
    ],
    TileEntities: []
};
var controlSchema = {
    Command: tagId("string"),
    auto: tagId("byte"),
    id: tagId("string"),
    x: tagId("int"),
    y: tagId("int"),
    z: tagId("int")
};

//see https://github.com/M4GNV5/node-minecraft-world/blob/master/src/nbt/writer.js
var toNBT = (function()
{
    function createWriter(bufferFunc, size)
    {
        return function(value)
        {
            var buff = new Buffer(size);
            buff[bufferFunc](value, 0);
            this.buffer.push(buff);
        };
    }

    function schemaToType(schema)
    {
        if(typeof schema == "number")
        {
            return schema;
        }
        else if(schema instanceof Array)
        {
            if(schema[0] === tags.indexOf("byte"))
                return tags.indexof("byteArray");
            else if(schema[0] === tags.indexOf("int"))
                return tags.indexof("intArray");
            else
                return tags.indexOf("list");
        }
        else if(typeof schema == "object")
        {
            return tags.indexOf("compound");
        }
    }

    var Writer = function(data, schema, cb)
    {
        this.buffer = [];

        this.byte(10);
        this.string(data.rootName);
        this.compound(data.root, schema);

        var buff = Buffer.concat(this.buffer);

        cb(undefined, buff);
    }

    Writer.prototype.byte = createWriter("writeUInt8", 1);
    Writer.prototype.short = createWriter("writeInt16BE", 2);
    Writer.prototype.int = createWriter("writeInt32BE", 4);
    Writer.prototype.float = createWriter("writeFloatBE", 4);
    Writer.prototype.double = createWriter("writeDoubleBE", 8);

    Writer.prototype.end = function()
    {
        this.byte(0);
    }
    Writer.prototype.long = function(val)
    {
        this.int(val.left);
        this.int(val.right);
    }
    Writer.prototype.byteArray = function(val)
    {
        this.int(val.length);
        for(var i = 0; i < val.length; i++)
        {
            this.byte(val[i]);
        }
    }
    Writer.prototype.string = function(val)
    {
        this.short(val.length);
        this.buffer.push(new Buffer(val, "utf8"));
    }
    Writer.prototype.list = function(val, schema)
    {
        var type = schemaToType(schema[0]);
        this.byte(type);
        this.int(val.length);
        for(var i = 0; i < val.length; i++)
        {
            this[tags[type]](val[i], schema[i]);
        }
    }
    Writer.prototype.compound = function(val, schema)
    {
        for(var key in schema)
        {
            if(!val.hasOwnProperty(key))
                continue;

            var type = schemaToType(schema[key]);
            this.byte(type);
            this.string(key);
            this[tags[type]](val[key], schema[key]);
        }
        this.byte(tags.indexOf("end"));
    }
    Writer.prototype.intArray = function(val)
    {
        this.int(val.length)
        for(var i = 0; i < val.length; i++)
        {
            this.int(val[i]);
        }
    }

    return function toNBT(data, schema, callback)
    {
        new Writer(data, schema, callback);
    };
})();

}).call(this,require("buffer").Buffer)
},{"./itemIds.json":9,"buffer":22,"fs":"fs"}],11:[function(require,module,exports){
var nextName = require("./../lib/naming.js");
var Integer = require("./Integer.js");
var String = require("./String.js");

function Boolean(startVal, name, silent)
{
    this.name = name || nextName("bool");

    if(startVal instanceof Boolean)
        startVal = startVal.base;
    else if(typeof startVal.toInteger == "function")
        startVal = startVal;
    else
        startVal = startVal ? 1 : 0;

    this.base = new Integer(startVal, this.name, silent);
}

Boolean.prototype.set = function(val, conditional)
{
    if(val instanceof Boolean)
        this.base.set(val.base, conditional);
    else if(typeof val.toInteger == "function")
        this.base.set(val, conditional);
    else if(typeof val == "boolean")
        this.base.set(val ? 1 : 0, conditional);
    else
        throw "Cannot assing '" + val.constructor.name + "' to a Boolean" + (new Error()).stack;
};

Boolean.prototype.toInteger = function()
{
    return this.base;
};

Boolean.prototype.clone = function(cloneName)
{
    return new Boolean(this, cloneName);
};

Boolean.prototype.toTellrawExtra = function()
{
    var val = new String("false");
    command(this.isExact(true));
    val.set("true", true);
    return val.toTellrawExtra();
};

Boolean.prototype.isExact = function(val)
{
    return this.base.isExact(val ? 1 : 0);
};

module.exports = Boolean;

},{"./../lib/naming.js":5,"./Integer.js":13,"./String.js":15}],12:[function(require,module,exports){
var nextName = require("./../lib/naming.js");
var Integer = require("./Integer.js");

function Float(startVal, name, silent)
{
    this.name = name || nextName("float");

    if(startVal instanceof Float)
    {
        startVal = startVal.base;
    }
    else if(typeof startVal == "object" && startVal.toInteger)
    {
        startVal = startVal.toInteger().clone();
        startVal.multiplicate(Float.accuracy);
    }
    else if(typeof startVal == "number")
    {
        startVal = Math.floor(startVal * Float.accuracy);
    }

    this.base = new Integer(startVal, this.name, silent);
}

Float.accuracy = 2; //digits after the comma

Float.accuracy = Math.pow(10, Float.accuracy);

function convertStatic(val)
{
    var _val = Math.floor(val * Float.accuracy);
    return _val;
}

Float.prototype.set = function(val, conditional)
{
    if(val instanceof Float)
    {
        this.base.set(val.base, conditional);
    }
    else if(typeof val.toInteger == "function")
    {
        this.base.set(val.toInteger(), conditional);
        this.base.multiplicate(100, conditional);
    }
    else if(typeof val == "number")
    {
        this.base.set(convertStatic(val), conditional);
    }
    else
    {
        throw "Cannot assing '" + val.constructor.name + "' to a Float";
    }
};

Float.prototype.add = function(val, conditional)
{
    if(val instanceof Float)
    {
        this.base.add(val.base, conditional);
    }
    else if(typeof val.toInteger == "function")
    {
        val = val.toInteger().clone();
        val.multiplicate(100);
        this.base.add(val, conditional);
    }
    else if(typeof val == "number")
    {
        this.base.add(convertStatic(val), conditional);
    }
    else
    {
        throw "Cannot add '" + val.constructor.name + "' to a Float";
    }
};

Float.prototype.remove = function(val, conditional)
{
    if(val instanceof Float)
    {
        this.base.remove(val.base, conditional);
    }
    else if(typeof val.toInteger == "function")
    {
        val = val.toInteger().clone();
        val.multiplicate(100);
        this.base.remove(val, conditional);
    }
    else if(typeof val == "number")
    {
        this.base.remove(convertStatic(val), conditional);
    }
    else
    {
        throw "Cannot remove '" + val.constructor.name + "' from a Float";
    }
};

Float.prototype.multiplicate = function(val, conditional)
{
    if(val instanceof Float)
    {
        this.base.multiplicate(val.base, conditional);
        this.base.divide(100, conditional);
    }
    else if(typeof val.toInteger == "function")
    {
        this.base.multiplicate(val, conditional);
    }
    else if(typeof val == "number")
    {
        this.base.multiplicate(convertStatic(val), conditional);
        this.base.divide(100, conditional);
    }
    else
    {
        throw "Cannot multiplicate '" + val.constructor.name + "' with a Float";
    }
};

Float.prototype.divide = function(val, conditional)
{
    if(val instanceof Float)
    {
        this.base.multiplicate(100, conditional);
        this.base.divide(val.base, conditional);
    }
    else if(typeof val.toInteger == "function")
    {
        this.base.divide(val, conditional);
    }
    else if(typeof val == "number")
    {
        this.base.multiplicate(100, conditional);
        this.base.divide(convertStatic(val), conditional);
    }
    else
    {
        throw "Cannot divide a Float through '" + val.constructor.name + "'";
    }
};

Float.prototype.mod = function(val, conditional)
{
    if(val instanceof Float)
    {
        this.base.mod(val.base, conditional);
    }
    else if(typeof val.toInteger == "function")
    {
        val = val.toInteger().clone();
        val.multiplicate(Float.accuracy, conditional);
        this.base.mod(val, conditional);
    }
    else if(typeof val == "number")
    {
        this.base.mod(convertStatic(val), conditional);
    }
    else
    {
        throw "Cannot assing '" + val.constructor.name + "' to a Float";
    }
};

Float.prototype.toInteger = function()
{
    var val = this.base.clone();
    val.divide(Float.accuracy);
    return val;
};

Float.prototype.clone = function(cloneName)
{
    return new Float(this, cloneName);
};

Float.prototype.toTellrawExtra = function()
{
    var left = this.base.clone(this.name + "left");
    var right = this.base.clone(this.name + "right");
    left.divide(Float.accuracy);
    right.mod(Float.accuracy);

    var leftExtra = {score: {objective: Integer.scoreName, name: left.name}};
    var rightExtra = {score: {objective: Integer.scoreName, name: right.name}};

    return JSON.stringify(leftExtra) + ",\".\"," + JSON.stringify(rightExtra);
};

Float.prototype.isExact = function(val)
{
    val = convertStatic(val) || val;
    return this.base.isBetween(val, val);
};

Float.prototype.isBetweenEx = function(min, max)
{
    min = convertStatic(min) || min;
    max = convertStatic(max) || max;
    return this.base.isBetweenEx(min, max);
};

Float.prototype.isBetween = function(min, max)
{
    min = convertStatic(min) || min;
    max = convertStatic(max) || max;

    return this.base.isBetween(min, max);
};

module.exports = Float;

},{"./../lib/naming.js":5,"./Integer.js":13}],13:[function(require,module,exports){
var Score = require("./Score.js");
var nextName = require("./../lib/naming.js");

function Integer(startVal, name, silent)
{
    this.name = name || nextName("int");

    startVal = startVal || 0;
    var startVal = typeof startVal.toInteger == "function" ? startVal : (parseInt(startVal) || 0);

    if(!silent)
        this.set(startVal);
}

Integer.statics = [];

Integer.scoreName = "MoonCraft";

Integer.prototype.set = function(val, conditional)
{
    if(val instanceof Score)
        this.operation("=", val.selector, val.scoreName, conditional);
    else if(typeof val.toInteger == "function")
        this.operation("=", val.toInteger().name, Integer.scoreName, conditional);
    else if(typeof val == "number")
        command(["scoreboard players set", this.name, Integer.scoreName, val].join(" "), conditional);
    else
        throw "Cannot assing '" + val.constructor.name + "' to an Integer";
};

Integer.prototype.add = function(val, conditional)
{
    if(val instanceof Score)
        this.operation("+=", val.selector, val.scoreName, conditional);
    else if(typeof val == "object" && typeof val.toInteger == "function")
        this.operation("+=", val.toInteger().name, Integer.scoreName, conditional);
    else if(typeof val == "number")
        command(["scoreboard players add", this.name, Integer.scoreName, val].join(" "), conditional);
    else
        throw "Cannot add '" + val.constructor.name + "' to an Integer";
};

Integer.prototype.remove = function(val, conditional)
{
    if(val instanceof Score)
        this.operation("-=", val.selector, val.scoreName, conditional);
    else if(typeof val == "object" && typeof val.toInteger == "function")
        this.operation("-=", val.toInteger().name, Integer.scoreName, conditional);
    else if(typeof val == "number")
        command(["scoreboard players remove", this.name, Integer.scoreName, val].join(" "), conditional);
    else
        throw "Cannot remove '" + val.constructor.name + "' to an Integer";
};

Integer.prototype.multiplicate = function(val, conditional)
{
    if(val instanceof Score)
        this.operation("*=", val.selector, val.scoreName, conditional);
    else if(typeof val == "object" && typeof val.toInteger == "function")
        this.operation("*=", val.toInteger().name, Integer.scoreName, conditional);
    else if(typeof val == "number")
        this.staticOperation("*=", val, conditional);
    else
        throw "Cannot multiplicate '" + val.constructor.name + "' with an Integer";
};

Integer.prototype.divide = function(val, conditional)
{
    if(val instanceof Score)
        this.operation("/=", val.selector, val.scoreName, conditional);
    else if(typeof val == "object" && typeof val.toInteger == "function")
        this.operation("/=", val.toInteger().name, Integer.scoreName, conditional);
    else if(typeof val == "number")
        this.staticOperation("/=", val, conditional);
    else
        throw "Cannot divide Integer through '" + val.constructor.name + "'";
};

Integer.prototype.mod = function(val, conditional)
{
    if(val instanceof Score)
        this.operation("%=", val.selector, val.scoreName, conditional);
    else if(typeof val == "object" && typeof val.toInteger == "function")
        this.operation("%=", val.toInteger().name, Integer.scoreName, conditional);
    else if(typeof val == "number")
        this.staticOperation("%=", val, conditional);
    else
        throw "Cannot divide Integer through '" + val.constructor.name + "'";
};

Integer.prototype.operation = function(op, otherName, otherScore, conditional)
{
    command(["scoreboard players operation", this.name, Integer.scoreName, op, otherName, otherScore].join(" "), conditional);
};

Integer.prototype.staticOperation = function(op, val, conditional)
{
    if(options.export)
        command(["scoreboard players set", "static" + val, Integer.scoreName, val].join(" "));
    else if(Integer.statics.indexOf(val) == -1)
        Integer.statics.push(val);

    this.operation(op, "static" + val.toString(), Integer.scoreName, conditional);
};

Integer.prototype.toInteger = function()
{
    return this;
};

Integer.prototype.clone = function(cloneName)
{
    return new Integer(this, cloneName);
};

Integer.prototype.toTellrawExtra = function()
{
    return JSON.stringify({score: {objective: Integer.scoreName, name: this.name}});
};

Integer.prototype.isExact = function(val)
{
    return this.isBetween(val, val);
};

Integer.prototype.isBetweenEx = function(min, max)
{
    return this.isBetween(min + 1 || min, max - 1 || max);
};

Integer.prototype.isBetween = function(min, max)
{
    min = typeof min == "number" ? min : -1 * Math.pow(2, 31);
    max = typeof max == "number" ? max : Math.pow(2, 31) - 1;

    return ["scoreboard players test", this.name, Integer.scoreName, min, max].join(" ");
};

module.exports = Integer;

},{"./../lib/naming.js":5,"./Score.js":14}],14:[function(require,module,exports){
var Integer = require("./Integer.js");

function Score(selector, scoreName)
{
    if(typeof Integer == "object") //fix cross requiring
        Integer = require("./Integer.js");

    this.selector = selector;
    this.scoreName = scoreName;
}

Score.prototype.set = function(val, conditional)
{
    if(val instanceof Score)
        this.operation("=", val.selector, val.scoreName, conditional);
    else if(typeof val.toInteger == "function")
        this.operation("=", val.toInteger().name, Integer.scoreName, conditional);
    else if(typeof val == "number")
        command(["scoreboard players set", this.selector, this.scoreName, val].join(" "), conditional);
    else
        throw "Cannot assing '" + val.constructor.name + "' to a Score";
};

Score.prototype.add = function(val, conditional)
{
    if(val instanceof Score)
        this.operation("+=", val.selector, val.scoreName, conditional);
    else if(typeof val == "object" && typeof val.toInteger == "function")
        this.operation("+=", val.toInteger().name, Integer.scoreName, conditional);
    else if(typeof val == "number")
        command(["scoreboard players add", this.selector, this.scoreName, val].join(" "), conditional);
    else
        throw "Cannot add '" + val.constructor.name + "' to a Score";
};

Score.prototype.remove = function(val, conditional)
{
    if(val instanceof Score)
        this.operation("-=", val.selector, val.scoreName, conditional);
    else if(typeof val == "object" && typeof val.toInteger == "function")
        this.operation("-=", val.toInteger().name, Integer.scoreName, conditional);
    else if(typeof val == "number")
        command(["scoreboard players remove", this.selector, this.scoreName, val].join(" "), conditional);
    else
        throw "Cannot remove '" + val.constructor.name + "' to a Score";
};

Score.prototype.multiplicate = function(val, conditional)
{
    if(val instanceof Score)
        this.operation("*=", val.selector, val.scoreName, conditional);
    else if(typeof val == "object" && typeof val.toInteger == "function")
        this.operation("*=", val.toInteger().name, Integer.scoreName, conditional);
    else if(typeof val == "number")
        this.staticOperation("*=", val, conditional);
    else
        throw "Cannot multiplicate '" + val.constructor.name + "' with a Score";
};

Score.prototype.divide = function(val, conditional)
{
    if(val instanceof Score)
        this.operation("/=", val.selector, val.scoreName, conditional);
    else if(typeof val == "object" && typeof val.toInteger == "function")
        this.operation("/=", val.toInteger().name, Integer.scoreName, conditional);
    else if(typeof val == "number")
        this.staticOperation("/=", val, conditional);
    else
        throw "Cannot divide Score through '" + val.constructor.name + "'";
};

Score.prototype.mod = function(val, conditional)
{
    if(val instanceof Score)
        this.operation("=", val.selector, val.scoreName, conditional);
    else if(typeof val == "object" && typeof val.toInteger == "function")
        this.operation("%=", val.toInteger().name, Integer.scoreName, conditional);
    else if(typeof val == "number")
        this.staticOperation("%=", val, conditional);
    else
        throw "Cannot divide Score through '" + val.constructor.name + "'";
};

Score.prototype.operation = function(op, otherName, otherScore, conditional)
{
    command(["scoreboard players operation", this.selector, this.scoreName, op, otherName, otherScore].join(" "), conditional);
};

Score.prototype.staticOperation = function(op, val, conditional)
{
    if(Integer.statics.indexOf(val) == -1)
        Integer.statics.push(val);
    this.operation(op, "static" + val.toString(), Integer.scoreName, conditional);
};

Score.prototype.toInteger = function(name)
{
    var val = new Integer(undefined, name);
    val.operation("=", this.selector, this.scoreName);
    return val;
};

Score.prototype.clone = function(cloneName)
{
    return this.toInteger(cloneName);
};

Score.prototype.toTellrawExtra = function()
{
    var val = this.toInteger();
    return val.toTellrawExtra();
};

Score.prototype.isExact = function(val)
{
    return this.isBetween(val, val);
};

Score.prototype.isBetweenEx = function(min, max)
{
    return this.isBetween(min + 1 || min, max - 1 || max);
};

Score.prototype.isBetween = function(min, max)
{
    min = typeof min == "number" ? min : -1 * Math.pow(2, 31);
    max = typeof max == "number" ? max : Math.pow(2, 31) - 1;

    return ["scoreboard players test", this.selector, this.scoreName, min, max].join(" ");
};

module.exports = Score;

},{"./Integer.js":13}],15:[function(require,module,exports){
var nextName = require("./../lib/naming.js");
var scope = require("./../lib/Scope.js");
var Integer = require("./Integer.js");

var nextId = 1;

function String(startVal, name, silent)
{
    if(silent)
        throw "cannot silently create a string";

    this.name = name || nextName("string");
    startVal = startVal || "";
    var _startVal = startVal.toString() || name;

    this.selector = "@e[type=ArmorStand,score_{0}_min={1},score_{0}={1},tag=string]".format(Integer.scoreName, nextId);

    command("kill {0}".format(this.selector));
    command("summon ArmorStand ~ ~1 ~ {NoGravity:1,CustomName:\"{0}\",Tags:[\"string\"]}".format(this.name));

    command("scoreboard players set @e[type=ArmorStand] {0} {1} {CustomName:\"{2}\"}".format(Integer.scoreName, nextId, this.name));
    nextId++;

    this.set(startVal.toString());

    //set invisible variable for garbage collector
    scope.set("." + this.name, this);
}

String.prototype.set = function(val, conditional)
{
    if(typeof val == "string")
        command("entitydata {0} {CustomName:\"{1}\"}".format(this.selector, val.toString()), conditional);
    else
        throw "Cannot assing '" + val.constructor.name + "' to a String";
};

String.prototype.clean = function()
{
    command("kill {0}".format(this.selector));
};

String.prototype.toTellrawExtra = function()
{
    return JSON.stringify({selector: this.selector});
};

String.prototype.isExact = function(val)
{
    return "testfor {0} {CustomName:\"{1}\"}".format(this.selector, val);
};

module.exports = String;

},{"./../lib/Scope.js":2,"./../lib/naming.js":5,"./Integer.js":13}],16:[function(require,module,exports){
var Integer = require("./Integer.js");
var Score = require("./Score.js");
var nextName = require("./../lib/naming.js");

function Table(val, name, silent)
{
    this.name = name || nextName("table");

    Table.used = true;

    Object.defineProperty(this, "length", {
        get: function()
        {
            var val = new Integer();
            val.isClone = true;
            command("execute @e[type=ArmorStand,tag={0}] ~ ~ ~ scoreboard players add {1} {2} 1"
                .format(this.name, val.name, Integer.scoreName));
            return val;
        }
    });

    Object.defineProperty(this, "maxn", {
        get: function()
        {
            var val = new Integer();
            val.isClone = true;
            var selfSel = "@e[type=ArmorStand,c=1,r=0,tag={0}]".format(table.name);

            command("execute @e[type=ArmorStand,tag={0}] ~ ~ ~ scoreboard players operation {1} {2} > {3} {4}"
                .format(table.name, val.name, Integer.scoreName, selfSel, Table.indexScoreName));
            return val;
        }
    });

    if(val && !silent)
        this.set(val);
}

Table.scoreName = Integer.scoreName;
Table.used = false;
Table.indexScoreName = "MoonCraftTable";
Table.tmpScoreName = "MoonCraftTmp";

Table.prototype.set = function(val)
{
    this.clean();

    if(val instanceof Table)
    {
        //super non hacky fix for table armorstands at same position
        command("spreadplayers ~ ~ 1 50 false @e[tag={0}]".format(val.name));

        var otherSel = "@e[type=ArmorStand,tag={0}]".format(val.name);
        var selfSel = "@e[type=ArmorStand,r=0,tag={0}]".format(val.name);
        var newSel = "@e[type=ArmorStand,tag=tableTmp,r=0]";

        command("execute {0} ~ ~ ~ summon ArmorStand ~ ~ ~ {NoGravity:true,Tags:[\"tableTmp\"]}".format(otherSel));
        command("execute {0} ~ ~ ~ scoreboard players operation {1} {2} = {3} {2}".format(otherSel, newSel, Table.indexScoreName, selfSel));
        command("execute {0} ~ ~ ~ scoreboard players operation {1} {2} = {3} {2}".format(otherSel, newSel, Table.scoreName, selfSel));
        command("entitydata @e[type=ArmorStand,tag=tableTmp] {Tags:[\"{0}\"]}".format(this.name));
    }
    else if(val instanceof Array)
    {
        var sel = "@e[type=ArmorStand,tag=tableTmp,c=1]";
        var score = new Score(sel, Table.scoreName);
        var index = new Score(sel, Table.indexScoreName);

        for(var i = 0; i < val.length; i++)
        {
            if(typeof val[i] == "object" && typeof val[i].toInteger != "function")
                throw "Cannot assing '" + val[i].constructor.name + "' to a Table";

            var _val = typeof val[i] == "object" ? val[i].toInteger() : val[i];

            command("summon ArmorStand ~ ~1 ~ {NoGravity:true,Tags:[\"tableTmp\"]}");
            score.set(_val);
            index.set(i + 1);

            command("entitydata {0} {Tags:[\"{1}\"]}".format(sel, this.name));
        }
    }
    else
    {
        throw "Cannot assing '" + val.constructor.name + "' to a Table";
    }
}

Table.prototype.clean = function()
{
    command("kill @e[type=ArmorStand,tag={0}]".format(this.name));
}

Table.prototype.insert = function(index, val)
{
    this.getScoreAt(index);

    if(typeof index == "number")
    {
        command("scoreboard players add @e[type=ArmorStand,tag={0},score_{1}_min={2}] {1} 1"
            .format(this.name, Table.indexScoreName, index));
    }
    else if(typeof index.toInteger == "function")
    {
        command("scoreboard players add @e[type=ArmorStand,tag={0},score_{1}_min=0] {2} 1"
            .format(this.name, Table.tmpScoreName, Table.indexScoreName));
    }

    var sel = "@e[type=ArmorStand,tag=tableTmp,c=1]";
    var score = new Score(sel, Table.scoreName);
    var _index = new Score(sel, Table.indexScoreName);

    command("summon ArmorStand ~ ~1 ~ {NoGravity:true,Tags:[\"tableTmp\"]}");
    score.set(val);
    _index.set(index);
    command("entitydata {0} {Tags:[\"{1}\"]}".format(sel, this.name));
}

Table.prototype.remove = function(index)
{
    var sel = this.getScoreAt(index).selector;
    command("kill " + sel);

    if(typeof index == "number")
    {
        command("scoreboard players remove @e[type=ArmorStand,tag={0},score_{1}_min={2}] {1} 1"
            .format(this.name, Table.indexScoreName, index));
    }
    else if(typeof index.toInteger == "function")
    {
        command("scoreboard players remove @e[type=ArmorStand,tag={0},score_{1}_min=0] {2} 1"
            .format(this.name, Table.tmpScoreName, Table.indexScoreName));
    }
}

Table.prototype.slice = function(start, end)
{
    if(typeof start == "number")
    {
        start = start - 1;
        command("kill @e[type=ArmorStand,tag={0},score_{1}={2}]".format(this.name, Table.indexScoreName, start));
        var index = new Score("@e[type=ArmorStand,tag={0}]".format(this.name), Table.indexScoreName);
        index.remove(start);

        if(typeof end == "number")
            end = end - start;
        else if(typeof (end || {}).toInteger == "function")
            end.remove(start);
    }
    else if(typeof start.toInteger == "function")
    {
        start = start.toInteger();
        start.remove(1);

        var sel = "@e[type=ArmorStand,tag={0}]".format(this.name);
        var selfSel = "@e[type=ArmorStand,c=1,r=0,tag={0}]".format(this.name);
        command("execute {0} ~ ~ ~ scoreboard players operation {1} {2} -= {3} {4}".format(sel, selfSel, Table.indexScoreName, start.name, Integer.scoreName));
        command("kill @e[type=ArmorStand,tag={0},score_{1}=0]".format(this.name, Table.indexScoreName));

        if(typeof end == "number")
            end = new Integer(end);

        if(typeof (end || {}).toInteger == "function")
            end.remove(start);
    }

    if(typeof end == "number")
    {
        command("kill @e[type=ArmorStand,tag={0},score_{1}_min={2}]".format(this.name, Table.indexScoreName, end + 1));
    }
    else if(typeof (end || {}).toInteger == "function")
    {
        this.getScoreAt(end);
        command("kill @e[type=ArmorStand,tag={0},score_{1}_min=1]".format(this.name, Table.tmpScoreName));
    }
}

Table.prototype.setAt = function(index, val)
{
    var score = this.getScoreAt(index);
    command("kill " + score.selector);

    command("summon ArmorStand %1:jmp% {NoGravity:true,Tags:[\"tableTmp\"]}".format(this.name));
    var sel = "@e[type=ArmorStand,tag=tableTmp]";
    if(typeof index == "number")
    {
        var indexScore = new Score(sel, Table.indexScoreName);
        indexScore.set(index);
    }
    else
    {
        var indexScore = new Score(sel, Table.indexScoreName);
        indexScore.set(index);
    }

    var valScore = new Score(sel, Table.scoreName);
    valScore.set(val);

    command("entitydata {0} {Tags:[\"{1}\"]}".format(sel, this.name));
}

Table.prototype.get = function(index)
{
    var score = this.getScoreAt(index);
    var val = score.toInteger();
    val.isClone = true;
    return val;
}

Table.prototype.getScoreAt = function(index)
{
    if(typeof index == "number")
    {
        var sel = "@e[type=ArmorStand,tag={0},score_{1}_min={2},score_{1}={2}]".format(this.name, Table.indexScoreName, index);
        return new Score(sel, Table.scoreName);
    }
    else if(typeof index.toInteger == "function")
    {
        index = index.toInteger();
        var sel = "@e[type=ArmorStand,tag={0}]".format(this.name);
        var selfSel = "@e[type=ArmorStand,c=1,r=0,tag={0}]".format(this.name);
        command("execute {0} ~ ~ ~ scoreboard players operation {1} {2} = {1} {3}".format(sel, selfSel, Table.tmpScoreName, Table.indexScoreName));
        command("execute {0} ~ ~ ~ scoreboard players operation {1} {2} -= {3} {4}".format(sel, selfSel, Table.tmpScoreName, index.name, Integer.scoreName));

        var valSel = "@e[type=ArmorStand,tag={0},score_{1}_min=0,score_{1}=0]".format(this.name, Table.tmpScoreName);
        return new Score(valSel, Table.scoreName);
    }
    else
    {
        throw "Cannot get value from a Table using an index of type '" + index.constructor.name + "'";
    }
}

Table.prototype.toTellrawExtra = function()
{
    var len = this.length.toTellrawExtra();
    return "\"table[\",{0},\"]\"".format(len);
}

module.exports = Table;

},{"./../lib/naming.js":5,"./Integer.js":13,"./Score.js":14}],17:[function(require,module,exports){
exports.out = function(val)
{
    var val = val.toTellrawExtra ? val.toTellrawExtra() : JSON.stringify(val.toString());
    command("tellraw @a [\"Output: \",{0}]".format(val));
}

exports.chat_message = function(text, color, format, click, hover)
{
    text = text || "";
    var msg = {text: text};

    if(color)
        msg.color = color;

    format = format || {};
    if(format.bold)
        msg.bold = format.bold;
    if(format.italic)
        msg.italic = format.italic;
    if(format.underlined)
        msg.underlined = format.underlined;
    if(format.strikethrough)
        msg.strikethrough = format.strikethrough;

    if(click)
        msg.clickEvent = click;
    if(hover)
        msg.hoverEvent = hover;

    return msg;
}

exports.chat_format = function(bold, italic, underlined, strikethrough)
{
    var format = {};
    if(bold)
        format.bold = true;
    if(italic)
        format.italic = true;
    if(underlined)
        format.underlined = true;
    if(strikethrough)
        format.strikethrough = true;

    return format;
}

exports.chat_event = function(action, value)
{
    return {action: action, value: value};
}

exports.chat_message_array = function()
{
    var extras = [];
    for(var i = 0; i < arguments.length; i++)
        extras[i] = arguments[i].toTellrawExtra ? arguments[i].toTellrawExtra() : JSON.stringify(arguments[i]);

    return "[{0}]".format(extras.join(","));
}

exports.tellraw = function()
{
    var msg = exports.chat_message_array.apply(exports, arguments);
    command("tellraw @a {0}".format(msg));
}

},{}],18:[function(require,module,exports){
var scoreName = scope.get("OBJECTIVE_NAME");

exports.query = function(val, kind, cmd)
{
    var selector = "@e[type=ArmorStand,tag=query]";
    command("summon ArmorStand ~ ~ ~ {Tags:[\"query\"],NoGravity:true}");
    command("scoreboard players set {0} {1} -1".format(selector, scoreName));
    command("stats block %1:diff% set {1} {0} {2}".format(selector, kind, scoreName));
    command(cmd);
    command("scoreboard players operation {0} {2} = {1} {2}".format(val.name, selector, scoreName));
    command("kill {0}".format(selector));
};

},{}],19:[function(require,module,exports){
var chat_message_array = require("./chat.js").chat_message_array;

exports.title = function()
{
    var msg = chat_message_array.apply(undefined, arguments);
    command("title @a title {0}".format(msg));
}

exports.subtitle = function()
{
    var msg = chat_message_array.apply(undefined, arguments);
    command("title @a subtitle {0}".format(msg));
}

exports.title_clear = function()
{
    command("title @a clear");
}

exports.title_times = function(fadeIn, stay, fadeOut)
{
    fadeIn = parseInt(fadeIn) || 0;
    stay = parseInt(stay) || 1;
    fadeOut = parseInt(fadeOut) || 0;

    command("title @a times {0} {1} {2}".format(fadeIn, stay, fadeOut));
}

exports.title_reset = function()
{
    command("title @a reset");
}

},{"./chat.js":17}],20:[function(require,module,exports){
String.prototype.format = function()
{
	var val = this;
	for(var i = 0; i < arguments.length; i++)
		val = val.replace(new RegExp("\\{" + i + "\\}", "g"), arguments[i]);
	return val;
};

var editor = ace.edit("editor");
editor.setTheme("ace/theme/monokai");
editor.getSession().setMode("ace/mode/lua");
editor.setOption("fontSize", 14);

var out = document.getElementById("outtext");

window.GLOBAL = window;
window.options = {
    splitterBlock: "stone",
    x: 0,
    //y: see below
    z: 0,
    length: 20,
    debug: false,
    export: false
};

var fakeFs = require("fs");
var base = require("../../MoonCraft/src/lib/base.js");
var parser = require("../../MoonCraft/src/luaparse.js");
var baseLib = require("../../MoonCraft/src/lib/baselib.js");
var compile = require("../../MoonCraft/src/compiler.js");
var toSchematic = require("../../MoonCraft/src/output/schematic.js");
var scope = require("../../MoonCraft/src/lib/Scope.js");
var naming = require("../../MoonCraft/src/lib/naming.js");
var types = require("../../MoonCraft/src/lib/types.js");
GLOBAL.scope = scope;

var oldImport = scope.get("import");

scope.set("import", function(name)
{
	var obj;
	if(name == "chat")
		obj = require("../../MoonCraft/stdlib/chat.js");
	else if(name == "title")
		obj = require("../../MoonCraft/stdlib/title.js");
	else if(name == "query")
		obj = require("../../MoonCraft/stdlib/query.js");
	else
		throw "Cannot import {0} browser demo only supports chat, title and query".format(name);

	for(var key in obj)
	{
		scope.set(key, obj[key]);
	}
});

function doIt(cb)
{
    try
    {
		var code = editor.getValue();
		fakeFs.writeFileSync("demo.lua", code);
		baseLib.import("demo.lua", true);
		base.output(cb);
    }
    catch(e)
    {
        out.innerHTML = e.toString().replace(/\n/g, "<br />");
    }

	baseLib.reset();
	base.reset();
	naming.names = {};
	types.Integer.statics = [];
}

var downloadA = document.createElement("a");
document.body.appendChild(downloadA);
downloadA.style = "display: none";
window.run = {
    showCommands: function()
    {
        options.y = 0;
        doIt(function(blocks, cmdBlocks)
        {
            var text = "<table class=\"table table-hover\"><tr><th>X</th><th>Z</th><th>Data</th><th>Command</th></tr>";

			for(var i = 0; i < cmdBlocks.length; i++)
			{
				text += "<tr><td>{0}</td><td>{1}</td><td>{2}</td><td>{3}</td></tr>"
					.format(cmdBlocks[i].x, cmdBlocks[i].z, cmdBlocks[i].data, cmdBlocks[i].command);
			}

			text += "</table>";
			out.innerHTML = text;
        });
    },
    schematic: function()
    {
		options.y = 0;
		doIt(function(blocks, cmdBlocks)
        {
			toSchematic(blocks, cmdBlocks, function(err, data)
			{
				if(err)
					out.innerHTML = err.toString();

				out.innerHTML = "Starting download...";

				var blob = new Blob([data], {type: "octet/stream"});
				var url = window.URL.createObjectURL(blob);
				downloadA.href = url;
				downloadA.download = "output.schematic";
				downloadA.click();
				window.URL.revokeObjectURL(url);

				out.innerHTML = "Download started";
			});
		});
    },
    demoServer: function()
    {
		options.y = 4;
    }
};

},{"../../MoonCraft/src/compiler.js":1,"../../MoonCraft/src/lib/Scope.js":2,"../../MoonCraft/src/lib/base.js":3,"../../MoonCraft/src/lib/baselib.js":4,"../../MoonCraft/src/lib/naming.js":5,"../../MoonCraft/src/lib/types.js":7,"../../MoonCraft/src/luaparse.js":8,"../../MoonCraft/src/output/schematic.js":10,"../../MoonCraft/stdlib/chat.js":17,"../../MoonCraft/stdlib/query.js":18,"../../MoonCraft/stdlib/title.js":19,"fs":"fs"}],21:[function(require,module,exports){
var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

;(function (exports) {
	'use strict';

  var Arr = (typeof Uint8Array !== 'undefined')
    ? Uint8Array
    : Array

	var PLUS   = '+'.charCodeAt(0)
	var SLASH  = '/'.charCodeAt(0)
	var NUMBER = '0'.charCodeAt(0)
	var LOWER  = 'a'.charCodeAt(0)
	var UPPER  = 'A'.charCodeAt(0)
	var PLUS_URL_SAFE = '-'.charCodeAt(0)
	var SLASH_URL_SAFE = '_'.charCodeAt(0)

	function decode (elt) {
		var code = elt.charCodeAt(0)
		if (code === PLUS ||
		    code === PLUS_URL_SAFE)
			return 62 // '+'
		if (code === SLASH ||
		    code === SLASH_URL_SAFE)
			return 63 // '/'
		if (code < NUMBER)
			return -1 //no match
		if (code < NUMBER + 10)
			return code - NUMBER + 26 + 26
		if (code < UPPER + 26)
			return code - UPPER
		if (code < LOWER + 26)
			return code - LOWER + 26
	}

	function b64ToByteArray (b64) {
		var i, j, l, tmp, placeHolders, arr

		if (b64.length % 4 > 0) {
			throw new Error('Invalid string. Length must be a multiple of 4')
		}

		// the number of equal signs (place holders)
		// if there are two placeholders, than the two characters before it
		// represent one byte
		// if there is only one, then the three characters before it represent 2 bytes
		// this is just a cheap hack to not do indexOf twice
		var len = b64.length
		placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0

		// base64 is 4/3 + up to two characters of the original data
		arr = new Arr(b64.length * 3 / 4 - placeHolders)

		// if there are placeholders, only get up to the last complete 4 chars
		l = placeHolders > 0 ? b64.length - 4 : b64.length

		var L = 0

		function push (v) {
			arr[L++] = v
		}

		for (i = 0, j = 0; i < l; i += 4, j += 3) {
			tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3))
			push((tmp & 0xFF0000) >> 16)
			push((tmp & 0xFF00) >> 8)
			push(tmp & 0xFF)
		}

		if (placeHolders === 2) {
			tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4)
			push(tmp & 0xFF)
		} else if (placeHolders === 1) {
			tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2)
			push((tmp >> 8) & 0xFF)
			push(tmp & 0xFF)
		}

		return arr
	}

	function uint8ToBase64 (uint8) {
		var i,
			extraBytes = uint8.length % 3, // if we have 1 byte left, pad 2 bytes
			output = "",
			temp, length

		function encode (num) {
			return lookup.charAt(num)
		}

		function tripletToBase64 (num) {
			return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F)
		}

		// go through the array every three bytes, we'll deal with trailing stuff later
		for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
			temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
			output += tripletToBase64(temp)
		}

		// pad the end with zeros, but make sure to not forget the extra bytes
		switch (extraBytes) {
			case 1:
				temp = uint8[uint8.length - 1]
				output += encode(temp >> 2)
				output += encode((temp << 4) & 0x3F)
				output += '=='
				break
			case 2:
				temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1])
				output += encode(temp >> 10)
				output += encode((temp >> 4) & 0x3F)
				output += encode((temp << 2) & 0x3F)
				output += '='
				break
		}

		return output
	}

	exports.toByteArray = b64ToByteArray
	exports.fromByteArray = uint8ToBase64
}(typeof exports === 'undefined' ? (this.base64js = {}) : exports))

},{}],22:[function(require,module,exports){
(function (global){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')
var isArray = require('isarray')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50
Buffer.poolSize = 8192 // not used by this implementation

var rootParent = {}

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * Due to various browser bugs, sometimes the Object implementation will be used even
 * when the browser supports typed arrays.
 *
 * Note:
 *
 *   - Firefox 4-29 lacks support for adding new properties to `Uint8Array` instances,
 *     See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438.
 *
 *   - Safari 5-7 lacks support for changing the `Object.prototype.constructor` property
 *     on objects.
 *
 *   - Chrome 9-10 is missing the `TypedArray.prototype.subarray` function.
 *
 *   - IE10 has a broken `TypedArray.prototype.subarray` function which returns arrays of
 *     incorrect length in some situations.

 * We detect these buggy browsers and set `Buffer.TYPED_ARRAY_SUPPORT` to `false` so they
 * get the Object implementation, which is slower but behaves correctly.
 */
Buffer.TYPED_ARRAY_SUPPORT = global.TYPED_ARRAY_SUPPORT !== undefined
  ? global.TYPED_ARRAY_SUPPORT
  : typedArraySupport()

function typedArraySupport () {
  function Bar () {}
  try {
    var arr = new Uint8Array(1)
    arr.foo = function () { return 42 }
    arr.constructor = Bar
    return arr.foo() === 42 && // typed array instances can be augmented
        arr.constructor === Bar && // constructor can be set
        typeof arr.subarray === 'function' && // chrome 9-10 lack `subarray`
        arr.subarray(1, 1).byteLength === 0 // ie10 has broken `subarray`
  } catch (e) {
    return false
  }
}

function kMaxLength () {
  return Buffer.TYPED_ARRAY_SUPPORT
    ? 0x7fffffff
    : 0x3fffffff
}

/**
 * Class: Buffer
 * =============
 *
 * The Buffer constructor returns instances of `Uint8Array` that are augmented
 * with function properties for all the node `Buffer` API functions. We use
 * `Uint8Array` so that square bracket notation works as expected -- it returns
 * a single octet.
 *
 * By augmenting the instances, we can avoid modifying the `Uint8Array`
 * prototype.
 */
function Buffer (arg) {
  if (!(this instanceof Buffer)) {
    // Avoid going through an ArgumentsAdaptorTrampoline in the common case.
    if (arguments.length > 1) return new Buffer(arg, arguments[1])
    return new Buffer(arg)
  }

  if (!Buffer.TYPED_ARRAY_SUPPORT) {
    this.length = 0
    this.parent = undefined
  }

  // Common case.
  if (typeof arg === 'number') {
    return fromNumber(this, arg)
  }

  // Slightly less common case.
  if (typeof arg === 'string') {
    return fromString(this, arg, arguments.length > 1 ? arguments[1] : 'utf8')
  }

  // Unusual.
  return fromObject(this, arg)
}

function fromNumber (that, length) {
  that = allocate(that, length < 0 ? 0 : checked(length) | 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) {
    for (var i = 0; i < length; i++) {
      that[i] = 0
    }
  }
  return that
}

function fromString (that, string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') encoding = 'utf8'

  // Assumption: byteLength() return value is always < kMaxLength.
  var length = byteLength(string, encoding) | 0
  that = allocate(that, length)

  that.write(string, encoding)
  return that
}

function fromObject (that, object) {
  if (Buffer.isBuffer(object)) return fromBuffer(that, object)

  if (isArray(object)) return fromArray(that, object)

  if (object == null) {
    throw new TypeError('must start with number, buffer, array or string')
  }

  if (typeof ArrayBuffer !== 'undefined') {
    if (object.buffer instanceof ArrayBuffer) {
      return fromTypedArray(that, object)
    }
    if (object instanceof ArrayBuffer) {
      return fromArrayBuffer(that, object)
    }
  }

  if (object.length) return fromArrayLike(that, object)

  return fromJsonObject(that, object)
}

function fromBuffer (that, buffer) {
  var length = checked(buffer.length) | 0
  that = allocate(that, length)
  buffer.copy(that, 0, 0, length)
  return that
}

function fromArray (that, array) {
  var length = checked(array.length) | 0
  that = allocate(that, length)
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

// Duplicate of fromArray() to keep fromArray() monomorphic.
function fromTypedArray (that, array) {
  var length = checked(array.length) | 0
  that = allocate(that, length)
  // Truncating the elements is probably not what people expect from typed
  // arrays with BYTES_PER_ELEMENT > 1 but it's compatible with the behavior
  // of the old Buffer constructor.
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

function fromArrayBuffer (that, array) {
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    array.byteLength
    that = Buffer._augment(new Uint8Array(array))
  } else {
    // Fallback: Return an object instance of the Buffer class
    that = fromTypedArray(that, new Uint8Array(array))
  }
  return that
}

function fromArrayLike (that, array) {
  var length = checked(array.length) | 0
  that = allocate(that, length)
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

// Deserialize { type: 'Buffer', data: [1,2,3,...] } into a Buffer object.
// Returns a zero-length buffer for inputs that don't conform to the spec.
function fromJsonObject (that, object) {
  var array
  var length = 0

  if (object.type === 'Buffer' && isArray(object.data)) {
    array = object.data
    length = checked(array.length) | 0
  }
  that = allocate(that, length)

  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

if (Buffer.TYPED_ARRAY_SUPPORT) {
  Buffer.prototype.__proto__ = Uint8Array.prototype
  Buffer.__proto__ = Uint8Array
} else {
  // pre-set for values that may exist in the future
  Buffer.prototype.length = undefined
  Buffer.prototype.parent = undefined
}

function allocate (that, length) {
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    that = Buffer._augment(new Uint8Array(length))
    that.__proto__ = Buffer.prototype
  } else {
    // Fallback: Return an object instance of the Buffer class
    that.length = length
    that._isBuffer = true
  }

  var fromPool = length !== 0 && length <= Buffer.poolSize >>> 1
  if (fromPool) that.parent = rootParent

  return that
}

function checked (length) {
  // Note: cannot use `length < kMaxLength` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= kMaxLength()) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + kMaxLength().toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (subject, encoding) {
  if (!(this instanceof SlowBuffer)) return new SlowBuffer(subject, encoding)

  var buf = new Buffer(subject, encoding)
  delete buf.parent
  return buf
}

Buffer.isBuffer = function isBuffer (b) {
  return !!(b != null && b._isBuffer)
}

Buffer.compare = function compare (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError('Arguments must be Buffers')
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  var i = 0
  var len = Math.min(x, y)
  while (i < len) {
    if (a[i] !== b[i]) break

    ++i
  }

  if (i !== len) {
    x = a[i]
    y = b[i]
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'binary':
    case 'base64':
    case 'raw':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!isArray(list)) throw new TypeError('list argument must be an Array of Buffers.')

  if (list.length === 0) {
    return new Buffer(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; i++) {
      length += list[i].length
    }
  }

  var buf = new Buffer(length)
  var pos = 0
  for (i = 0; i < list.length; i++) {
    var item = list[i]
    item.copy(buf, pos)
    pos += item.length
  }
  return buf
}

function byteLength (string, encoding) {
  if (typeof string !== 'string') string = '' + string

  var len = string.length
  if (len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'binary':
      // Deprecated
      case 'raw':
      case 'raws':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) return utf8ToBytes(string).length // assume utf8
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  start = start | 0
  end = end === undefined || end === Infinity ? this.length : end | 0

  if (!encoding) encoding = 'utf8'
  if (start < 0) start = 0
  if (end > this.length) end = this.length
  if (end <= start) return ''

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'binary':
        return binarySlice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toString = function toString () {
  var length = this.length | 0
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max) str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return 0
  return Buffer.compare(this, b)
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset) {
  if (byteOffset > 0x7fffffff) byteOffset = 0x7fffffff
  else if (byteOffset < -0x80000000) byteOffset = -0x80000000
  byteOffset >>= 0

  if (this.length === 0) return -1
  if (byteOffset >= this.length) return -1

  // Negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = Math.max(this.length + byteOffset, 0)

  if (typeof val === 'string') {
    if (val.length === 0) return -1 // special case: looking for empty string always fails
    return String.prototype.indexOf.call(this, val, byteOffset)
  }
  if (Buffer.isBuffer(val)) {
    return arrayIndexOf(this, val, byteOffset)
  }
  if (typeof val === 'number') {
    if (Buffer.TYPED_ARRAY_SUPPORT && Uint8Array.prototype.indexOf === 'function') {
      return Uint8Array.prototype.indexOf.call(this, val, byteOffset)
    }
    return arrayIndexOf(this, [ val ], byteOffset)
  }

  function arrayIndexOf (arr, val, byteOffset) {
    var foundIndex = -1
    for (var i = 0; byteOffset + i < arr.length; i++) {
      if (arr[byteOffset + i] === val[foundIndex === -1 ? 0 : i - foundIndex]) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === val.length) return byteOffset + foundIndex
      } else {
        foundIndex = -1
      }
    }
    return -1
  }

  throw new TypeError('val must be string, number or Buffer')
}

// `get` is deprecated
Buffer.prototype.get = function get (offset) {
  console.log('.get() is deprecated. Access using array indexes instead.')
  return this.readUInt8(offset)
}

// `set` is deprecated
Buffer.prototype.set = function set (v, offset) {
  console.log('.set() is deprecated. Access using array indexes instead.')
  return this.writeUInt8(v, offset)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  if (strLen % 2 !== 0) throw new Error('Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; i++) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (isNaN(parsed)) throw new Error('Invalid hex string')
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function binaryWrite (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset | 0
    if (isFinite(length)) {
      length = length | 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  // legacy write(string, encoding, offset, length) - remove in v0.13
  } else {
    var swap = encoding
    encoding = offset
    offset = length | 0
    length = swap
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'binary':
        return binaryWrite(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
      : (firstByte > 0xBF) ? 2
      : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function binarySlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; i++) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256)
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    newBuf = Buffer._augment(this.subarray(start, end))
  } else {
    var sliceLen = end - start
    newBuf = new Buffer(sliceLen, undefined)
    for (var i = 0; i < sliceLen; i++) {
      newBuf[i] = this[i + start]
    }
  }

  if (newBuf.length) newBuf.parent = this.parent || this

  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('buffer must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('value is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  this[offset] = (value & 0xff)
  return offset + 1
}

function objectWriteUInt16 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 2); i < j; i++) {
    buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
      (littleEndian ? i : 1 - i) * 8
  }
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

function objectWriteUInt32 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffffffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 4); i < j; i++) {
    buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset + 3] = (value >>> 24)
    this[offset + 2] = (value >>> 16)
    this[offset + 1] = (value >>> 8)
    this[offset] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = value < 0 ? 1 : 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = value < 0 ? 1 : 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
    this[offset + 2] = (value >>> 16)
    this[offset + 3] = (value >>> 24)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (value > max || value < min) throw new RangeError('value is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('index out of range')
  if (offset < 0) throw new RangeError('index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('sourceStart out of bounds')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start
  var i

  if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (i = len - 1; i >= 0; i--) {
      target[i + targetStart] = this[i + start]
    }
  } else if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
    // ascending copy from start
    for (i = 0; i < len; i++) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    target._set(this.subarray(start, start + len), targetStart)
  }

  return len
}

// fill(value, start=0, end=buffer.length)
Buffer.prototype.fill = function fill (value, start, end) {
  if (!value) value = 0
  if (!start) start = 0
  if (!end) end = this.length

  if (end < start) throw new RangeError('end < start')

  // Fill 0 bytes; we're done
  if (end === start) return
  if (this.length === 0) return

  if (start < 0 || start >= this.length) throw new RangeError('start out of bounds')
  if (end < 0 || end > this.length) throw new RangeError('end out of bounds')

  var i
  if (typeof value === 'number') {
    for (i = start; i < end; i++) {
      this[i] = value
    }
  } else {
    var bytes = utf8ToBytes(value.toString())
    var len = bytes.length
    for (i = start; i < end; i++) {
      this[i] = bytes[i % len]
    }
  }

  return this
}

/**
 * Creates a new `ArrayBuffer` with the *copied* memory of the buffer instance.
 * Added in Node 0.12. Only available in browsers that support ArrayBuffer.
 */
Buffer.prototype.toArrayBuffer = function toArrayBuffer () {
  if (typeof Uint8Array !== 'undefined') {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      return (new Buffer(this)).buffer
    } else {
      var buf = new Uint8Array(this.length)
      for (var i = 0, len = buf.length; i < len; i += 1) {
        buf[i] = this[i]
      }
      return buf.buffer
    }
  } else {
    throw new TypeError('Buffer.toArrayBuffer not supported in this browser')
  }
}

// HELPER FUNCTIONS
// ================

var BP = Buffer.prototype

/**
 * Augment a Uint8Array *instance* (not the Uint8Array class!) with Buffer methods
 */
Buffer._augment = function _augment (arr) {
  arr.constructor = Buffer
  arr._isBuffer = true

  // save reference to original Uint8Array set method before overwriting
  arr._set = arr.set

  // deprecated
  arr.get = BP.get
  arr.set = BP.set

  arr.write = BP.write
  arr.toString = BP.toString
  arr.toLocaleString = BP.toString
  arr.toJSON = BP.toJSON
  arr.equals = BP.equals
  arr.compare = BP.compare
  arr.indexOf = BP.indexOf
  arr.copy = BP.copy
  arr.slice = BP.slice
  arr.readUIntLE = BP.readUIntLE
  arr.readUIntBE = BP.readUIntBE
  arr.readUInt8 = BP.readUInt8
  arr.readUInt16LE = BP.readUInt16LE
  arr.readUInt16BE = BP.readUInt16BE
  arr.readUInt32LE = BP.readUInt32LE
  arr.readUInt32BE = BP.readUInt32BE
  arr.readIntLE = BP.readIntLE
  arr.readIntBE = BP.readIntBE
  arr.readInt8 = BP.readInt8
  arr.readInt16LE = BP.readInt16LE
  arr.readInt16BE = BP.readInt16BE
  arr.readInt32LE = BP.readInt32LE
  arr.readInt32BE = BP.readInt32BE
  arr.readFloatLE = BP.readFloatLE
  arr.readFloatBE = BP.readFloatBE
  arr.readDoubleLE = BP.readDoubleLE
  arr.readDoubleBE = BP.readDoubleBE
  arr.writeUInt8 = BP.writeUInt8
  arr.writeUIntLE = BP.writeUIntLE
  arr.writeUIntBE = BP.writeUIntBE
  arr.writeUInt16LE = BP.writeUInt16LE
  arr.writeUInt16BE = BP.writeUInt16BE
  arr.writeUInt32LE = BP.writeUInt32LE
  arr.writeUInt32BE = BP.writeUInt32BE
  arr.writeIntLE = BP.writeIntLE
  arr.writeIntBE = BP.writeIntBE
  arr.writeInt8 = BP.writeInt8
  arr.writeInt16LE = BP.writeInt16LE
  arr.writeInt16BE = BP.writeInt16BE
  arr.writeInt32LE = BP.writeInt32LE
  arr.writeInt32BE = BP.writeInt32BE
  arr.writeFloatLE = BP.writeFloatLE
  arr.writeFloatBE = BP.writeFloatBE
  arr.writeDoubleLE = BP.writeDoubleLE
  arr.writeDoubleBE = BP.writeDoubleBE
  arr.fill = BP.fill
  arr.inspect = BP.inspect
  arr.toArrayBuffer = BP.toArrayBuffer

  return arr
}

var INVALID_BASE64_RE = /[^+\/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; i++) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; i++) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"base64-js":21,"ieee754":24,"isarray":23}],23:[function(require,module,exports){
var toString = {}.toString;

module.exports = Array.isArray || function (arr) {
  return toString.call(arr) == '[object Array]';
};

},{}],24:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],25:[function(require,module,exports){

var indexOf = [].indexOf;

module.exports = function(arr, obj){
  if (indexOf) return arr.indexOf(obj);
  for (var i = 0; i < arr.length; ++i) {
    if (arr[i] === obj) return i;
  }
  return -1;
};
},{}],26:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// resolves . and .. elements in a path array with directory names there
// must be no slashes, empty elements, or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = parts.length - 1; i >= 0; i--) {
    var last = parts[i];
    if (last === '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (allowAboveRoot) {
    for (; up--; up) {
      parts.unshift('..');
    }
  }

  return parts;
}

// Split a filename into [root, dir, basename, ext], unix version
// 'root' is just a slash, or nothing.
var splitPathRe =
    /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
var splitPath = function(filename) {
  return splitPathRe.exec(filename).slice(1);
};

// path.resolve([from ...], to)
// posix version
exports.resolve = function() {
  var resolvedPath = '',
      resolvedAbsolute = false;

  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    var path = (i >= 0) ? arguments[i] : process.cwd();

    // Skip empty and invalid entries
    if (typeof path !== 'string') {
      throw new TypeError('Arguments to path.resolve must be strings');
    } else if (!path) {
      continue;
    }

    resolvedPath = path + '/' + resolvedPath;
    resolvedAbsolute = path.charAt(0) === '/';
  }

  // At this point the path should be resolved to a full absolute path, but
  // handle relative paths to be safe (might happen when process.cwd() fails)

  // Normalize the path
  resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
    return !!p;
  }), !resolvedAbsolute).join('/');

  return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
};

// path.normalize(path)
// posix version
exports.normalize = function(path) {
  var isAbsolute = exports.isAbsolute(path),
      trailingSlash = substr(path, -1) === '/';

  // Normalize the path
  path = normalizeArray(filter(path.split('/'), function(p) {
    return !!p;
  }), !isAbsolute).join('/');

  if (!path && !isAbsolute) {
    path = '.';
  }
  if (path && trailingSlash) {
    path += '/';
  }

  return (isAbsolute ? '/' : '') + path;
};

// posix version
exports.isAbsolute = function(path) {
  return path.charAt(0) === '/';
};

// posix version
exports.join = function() {
  var paths = Array.prototype.slice.call(arguments, 0);
  return exports.normalize(filter(paths, function(p, index) {
    if (typeof p !== 'string') {
      throw new TypeError('Arguments to path.join must be strings');
    }
    return p;
  }).join('/'));
};


// path.relative(from, to)
// posix version
exports.relative = function(from, to) {
  from = exports.resolve(from).substr(1);
  to = exports.resolve(to).substr(1);

  function trim(arr) {
    var start = 0;
    for (; start < arr.length; start++) {
      if (arr[start] !== '') break;
    }

    var end = arr.length - 1;
    for (; end >= 0; end--) {
      if (arr[end] !== '') break;
    }

    if (start > end) return [];
    return arr.slice(start, end - start + 1);
  }

  var fromParts = trim(from.split('/'));
  var toParts = trim(to.split('/'));

  var length = Math.min(fromParts.length, toParts.length);
  var samePartsLength = length;
  for (var i = 0; i < length; i++) {
    if (fromParts[i] !== toParts[i]) {
      samePartsLength = i;
      break;
    }
  }

  var outputParts = [];
  for (var i = samePartsLength; i < fromParts.length; i++) {
    outputParts.push('..');
  }

  outputParts = outputParts.concat(toParts.slice(samePartsLength));

  return outputParts.join('/');
};

exports.sep = '/';
exports.delimiter = ':';

exports.dirname = function(path) {
  var result = splitPath(path),
      root = result[0],
      dir = result[1];

  if (!root && !dir) {
    // No dirname whatsoever
    return '.';
  }

  if (dir) {
    // It has a dirname, strip trailing slash
    dir = dir.substr(0, dir.length - 1);
  }

  return root + dir;
};


exports.basename = function(path, ext) {
  var f = splitPath(path)[2];
  // TODO: make this comparison case-insensitive on windows?
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
};


exports.extname = function(path) {
  return splitPath(path)[3];
};

function filter (xs, f) {
    if (xs.filter) return xs.filter(f);
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        if (f(xs[i], i, xs)) res.push(xs[i]);
    }
    return res;
}

// String.prototype.substr - negative index don't work in IE8
var substr = 'ab'.substr(-1) === 'b'
    ? function (str, start, len) { return str.substr(start, len) }
    : function (str, start, len) {
        if (start < 0) start = str.length + start;
        return str.substr(start, len);
    }
;

}).call(this,require('_process'))
},{"_process":27}],27:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        setTimeout(drainQueue, 0);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],28:[function(require,module,exports){
var indexOf = require('indexof');

var Object_keys = function (obj) {
    if (Object.keys) return Object.keys(obj)
    else {
        var res = [];
        for (var key in obj) res.push(key)
        return res;
    }
};

var forEach = function (xs, fn) {
    if (xs.forEach) return xs.forEach(fn)
    else for (var i = 0; i < xs.length; i++) {
        fn(xs[i], i, xs);
    }
};

var defineProp = (function() {
    try {
        Object.defineProperty({}, '_', {});
        return function(obj, name, value) {
            Object.defineProperty(obj, name, {
                writable: true,
                enumerable: false,
                configurable: true,
                value: value
            })
        };
    } catch(e) {
        return function(obj, name, value) {
            obj[name] = value;
        };
    }
}());

var globals = ['Array', 'Boolean', 'Date', 'Error', 'EvalError', 'Function',
'Infinity', 'JSON', 'Math', 'NaN', 'Number', 'Object', 'RangeError',
'ReferenceError', 'RegExp', 'String', 'SyntaxError', 'TypeError', 'URIError',
'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape',
'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined', 'unescape'];

function Context() {}
Context.prototype = {};

var Script = exports.Script = function NodeScript (code) {
    if (!(this instanceof Script)) return new Script(code);
    this.code = code;
};

Script.prototype.runInContext = function (context) {
    if (!(context instanceof Context)) {
        throw new TypeError("needs a 'context' argument.");
    }
    
    var iframe = document.createElement('iframe');
    if (!iframe.style) iframe.style = {};
    iframe.style.display = 'none';
    
    document.body.appendChild(iframe);
    
    var win = iframe.contentWindow;
    var wEval = win.eval, wExecScript = win.execScript;

    if (!wEval && wExecScript) {
        // win.eval() magically appears when this is called in IE:
        wExecScript.call(win, 'null');
        wEval = win.eval;
    }
    
    forEach(Object_keys(context), function (key) {
        win[key] = context[key];
    });
    forEach(globals, function (key) {
        if (context[key]) {
            win[key] = context[key];
        }
    });
    
    var winKeys = Object_keys(win);

    var res = wEval.call(win, this.code);
    
    forEach(Object_keys(win), function (key) {
        // Avoid copying circular objects like `top` and `window` by only
        // updating existing context properties or new properties in the `win`
        // that was only introduced after the eval.
        if (key in context || indexOf(winKeys, key) === -1) {
            context[key] = win[key];
        }
    });

    forEach(globals, function (key) {
        if (!(key in context)) {
            defineProp(context, key, win[key]);
        }
    });
    
    document.body.removeChild(iframe);
    
    return res;
};

Script.prototype.runInThisContext = function () {
    return eval(this.code); // maybe...
};

Script.prototype.runInNewContext = function (context) {
    var ctx = Script.createContext(context);
    var res = this.runInContext(ctx);

    forEach(Object_keys(ctx), function (key) {
        context[key] = ctx[key];
    });

    return res;
};

forEach(Object_keys(Script.prototype), function (name) {
    exports[name] = Script[name] = function (code) {
        var s = Script(code);
        return s[name].apply(s, [].slice.call(arguments, 1));
    };
});

exports.createScript = function (code) {
    return exports.Script(code);
};

exports.createContext = Script.createContext = function (context) {
    var copy = new Context();
    if(typeof context === 'object') {
        forEach(Object_keys(context), function (key) {
            copy[key] = context[key];
        });
    }
    return copy;
};

},{"indexof":25}],"fs":[function(require,module,exports){
var fs = {};

exports.readdirSync = function()
{
    //for now MoonCraft only readdirs the stdlib directory
    return Object.keys(fs);
}

exports.existsSync = function(file)
{
    var split = file.split("/");
    if(fs.hasOwnProperty(split[split.length - 1]))
        return true;
    return false;
}

exports.readFileSync = function(file)
{
    var split = file.split("/");
    return fs[split[split.length - 1]];
}

exports.writeFileSync = function(file, data)
{
    fs[file] = data;
}

},{}]},{},[20]);

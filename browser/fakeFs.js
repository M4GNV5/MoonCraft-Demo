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

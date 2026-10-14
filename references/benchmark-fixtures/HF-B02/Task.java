public class Task { public static String stem(String name,String extension){return name.endsWith("."+extension)?name.substring(0,name.length()-extension.length()-1):name;} }

if(NOT "$ENV{T3CODE_ANDROID_BUILD_CACHE}" STREQUAL "1")
  return()
endif()

find_program(T3CODE_CCACHE_EXECUTABLE ccache REQUIRED)

# React Native sets this same property, so its app hook replaces rather than nests our launcher.
set_property(GLOBAL PROPERTY RULE_LAUNCH_COMPILE "\"${T3CODE_CCACHE_EXECUTABLE}\"")
